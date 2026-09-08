import {
  ContingencyRpcs,
  makeBrowserRpcError,
  isBrowserRpcError,
  recordingIsInProgress,
  recordingLocksBrowserControls,
  recordingLocksStorageMutations,
  recordingMakesBrowserInputReadOnly,
  STORAGE_LOCKED_MESSAGE,
} from "@contingency/protocol";
import type {
  AgentFlowRevision,
  BrowserRpcErrorType,
  RecordingSnapshot,
  RunSnapshot,
  SessionId,
} from "@contingency/protocol";
import { Effect, Layer, Option, Result, Stream } from "effect";
import type { FileSystem } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { AgentFlowCatalog } from "../services/agent-flow-catalog.ts";
import type {
  AgentFlowCatalogError,
  AgentFlowCatalogService,
} from "../services/agent-flow-catalog.ts";
import { compileAgentFlowDraft } from "../services/agent-flow-compiler.ts";
import { AgentRunStore } from "../services/agent-run-store.ts";
import type {
  AgentRunStoreError,
  AgentRunStoreService,
} from "../services/agent-run-store.ts";
import {
  AgentSession,
  verificationStartingUrl,
} from "../services/agent-session.ts";
import type {
  AgentSessionError,
  AgentSessionService,
} from "../services/agent-session.ts";
import { CreateBrowser } from "../services/create-browser.ts";
import { Recording } from "../services/recording.ts";
import { RunSession } from "../services/run-session.ts";
import type { RunSessionService } from "../services/run-session.ts";
import type { RunnerService } from "../services/runner.ts";
import {
  isAllowedHost,
  isAllowedWebSocketOrigin,
} from "../services/web-url.ts";

export const browserInputIsReadOnly = (
  snapshot: Pick<
    RecordingSnapshot,
    "captureMode" | "phase" | "sessionId"
  > | null,
  sessionId: string
): boolean =>
  snapshot?.sessionId === sessionId &&
  recordingMakesBrowserInputReadOnly(snapshot);

export const browserControlIsLocked = (
  snapshot: Pick<RecordingSnapshot, "phase" | "sessionId"> | null,
  sessionId: string
): boolean => recordingLocksBrowserControls(snapshot, sessionId);

export const storageMutationIsLocked = (
  snapshot: Pick<RecordingSnapshot, "phase" | "sessionId"> | null,
  sessionId: string
): boolean => recordingLocksStorageMutations(snapshot, sessionId);

/**
 * Catalog failures Agent View shows the user. An IO failure is reported as an
 * invalid Catalog Root because that is what the user can actually act on.
 */
const catalogRpcError = (cause: AgentFlowCatalogError): BrowserRpcErrorType =>
  makeBrowserRpcError(
    cause.code === "agent_catalog_io" ? "agent_catalog_invalid" : cause.code,
    cause.message
  );

const agentError = (cause: AgentSessionError): BrowserRpcErrorType =>
  isBrowserRpcError(cause)
    ? cause
    : makeBrowserRpcError(cause.code, cause.message);

const agentSessionBrowserPrivate = () =>
  makeBrowserRpcError(
    "agent_session_conflict",
    "Agent Session browser handles are private to the Agent Session boundary."
  );

const requireGenericBrowserSession = (sessionId: SessionId) =>
  Effect.serviceOption(AgentSession).pipe(
    Effect.flatMap((service) =>
      Option.isNone(service)
        ? Effect.void
        : service.value
            .ownsBrowserSession(sessionId)
            .pipe(
              Effect.flatMap((owned) =>
                owned ? Effect.fail(agentSessionBrowserPrivate()) : Effect.void
              )
            )
    )
  );

const genericBrowser = <A>(
  sessionId: SessionId | undefined,
  operation: Effect.Effect<A, BrowserRpcErrorType>
) =>
  sessionId === undefined
    ? operation
    : requireGenericBrowserSession(sessionId).pipe(Effect.andThen(operation));

const filterGenericBrowserSessions = (sessions: readonly SessionId[]) =>
  Effect.serviceOption(AgentSession).pipe(
    Effect.flatMap((service) =>
      Option.isNone(service)
        ? Effect.succeed([...sessions])
        : Effect.all(
            sessions.map((sessionId) =>
              service.value
                .ownsBrowserSession(sessionId)
                .pipe(Effect.map((owned) => (owned ? undefined : sessionId)))
            )
          ).pipe(
            Effect.map((visible) =>
              visible.filter(
                (sessionId): sessionId is SessionId => sessionId !== undefined
              )
            )
          )
    )
  );

/**
 * Persisted Run evidence, read by Agent View in summary mode and by the
 * read-only viewer `open_run` returns. It is optional for the same reason
 * the catalog is: a process serving Audit View alone has no Run store.
 */
const runStoreUnavailable = <A>(
  operation: (
    service: AgentRunStoreService
  ) => Effect.Effect<A, AgentRunStoreError>
): Effect.Effect<A, BrowserRpcErrorType> =>
  Effect.serviceOption(AgentRunStore).pipe(
    Effect.flatMap((service) =>
      Option.isSome(service)
        ? operation(service.value).pipe(
            Effect.mapError((cause) =>
              makeBrowserRpcError(
                cause.code === "agent_run_io"
                  ? "agent_run_invalid"
                  : cause.code,
                cause.message
              )
            )
          )
        : Effect.fail(
            makeBrowserRpcError(
              "agent_run_invalid",
              "No Agent Run store is available in this server process."
            )
          )
    )
  );

/** Every Recording operation answers with the Recording it produced. */
const recordingResult = (
  operation: Effect.Effect<RecordingSnapshot, BrowserRpcErrorType>
) =>
  operation.pipe(
    Effect.map((snapshot) => ({
      data: { recording: snapshot },
      type: "recording.result" as const,
    }))
  );

/** Every Run operation answers with the Run this process was opened on. */
const runResult = (
  operation: Effect.Effect<RunSnapshot | null, BrowserRpcErrorType>
) =>
  operation.pipe(
    Effect.map((run) => ({ data: { run }, type: "run.result" as const }))
  );

export const RpcHandlersLive = ContingencyRpcs.toLayer(
  Effect.gen(function* makeRpcHandlers() {
    const browser = yield* CreateBrowser;
    const recording = yield* Recording;
    const runSession = yield* RunSession;

    const agentUnavailable = <A>(
      operation: (
        service: AgentSessionService
      ) => Effect.Effect<A, AgentSessionError>
    ): Effect.Effect<A, BrowserRpcErrorType> =>
      Effect.serviceOption(AgentSession).pipe(
        Effect.flatMap((service) =>
          Option.isSome(service)
            ? operation(service.value).pipe(Effect.mapError(agentError))
            : Effect.fail(
                makeBrowserRpcError(
                  "agent_session_unavailable",
                  "Agent Sessions are unavailable in this server process."
                )
              )
        )
      );
    /**
     * Agent Flow Catalog operations exposed to Agent View over loopback RPC.
     * The catalog is optional in a process that serves Audit View alone, so
     * its absence is a refusal rather than a crash.
     */
    const catalogUnavailable = <A>(
      operation: (
        service: AgentFlowCatalogService
      ) => Effect.Effect<A, AgentFlowCatalogError>
    ): Effect.Effect<A, BrowserRpcErrorType> =>
      Effect.serviceOption(AgentFlowCatalog).pipe(
        Effect.flatMap((service) =>
          Option.isSome(service)
            ? operation(service.value).pipe(Effect.mapError(catalogRpcError))
            : Effect.fail(
                makeBrowserRpcError(
                  "agent_catalog_invalid",
                  "No Agent Flow Catalog is available in this server process."
                )
              )
        )
      );

    /**
     * Every draft-review answer carries the revision and the bounded evidence
     * summaries beside it, so Agent View always shows what the Steps under
     * review are actually backed by.
     */
    const revisionResult = (
      operation: Effect.Effect<AgentFlowRevision, BrowserRpcErrorType>
    ) =>
      operation.pipe(
        Effect.flatMap((revision) =>
          catalogUnavailable((catalog) =>
            catalog.evidence(
              revision.manifest.agentFlowId,
              revision.manifest.revisionId
            )
          ).pipe(
            // The catalog derives one Slice per Step in Step order. A Step
            // whose Slice is missing is a broken evidence package, not a Step
            // to review quietly without it.
            Effect.flatMap((slices) =>
              Effect.all(
                revision.manifest.steps.map((step, stepIndex) => {
                  const slice = slices[stepIndex];
                  return slice === undefined
                    ? Effect.fail(
                        makeBrowserRpcError(
                          "agent_flow_invalid",
                          `Agent Flow ${revision.manifest.agentFlowId} revision ${revision.manifest.revisionId} has no Evidence Slice for Agent Step ${stepIndex + 1}.`
                        )
                      )
                    : Effect.succeed({
                        actions: slice.actions.map((action) => ({
                          actor: action.actor,
                          description: action.description,
                          id: action.id,
                          outcome: action.outcome,
                          urlAfter: action.urlAfter,
                        })),
                        endedAt: slice.endedAt,
                        hash: step.evidence.hash,
                        instructions: slice.instructions.map(
                          ({ text }) => text
                        ),
                        screenshotCount: slice.screenshots.length,
                        startedAt: slice.startedAt,
                        stepIndex,
                        urlTransitionCount: slice.urlTransitions.length,
                      });
                })
              ).pipe(
                Effect.map((evidence) => ({
                  data: { evidence, revision },
                  type: "agent.flow.revision.result" as const,
                }))
              )
            )
          )
        )
      );

    const agentStream = <A>(
      operation: (
        service: AgentSessionService
      ) => Stream.Stream<A, AgentSessionError>
    ) =>
      Stream.unwrap(
        agentUnavailable((service) =>
          Effect.succeed(operation(service).pipe(Stream.mapError(agentError)))
        )
      );

    /**
     * A Run and a Recording cannot share the process: a Recording drives a
     * live session and a Run is context-isolated, so the second is refused
     * rather than contended for (ADR 0023).
     */
    const requireNoRecording = recording
      .get()
      .pipe(
        Effect.flatMap((snapshot) =>
          recordingIsInProgress(snapshot)
            ? Effect.fail(
                makeBrowserRpcError(
                  "recording_conflict",
                  "A Run cannot start while this Recording is in progress."
                )
              )
            : Effect.void
        )
      );

    const requireBrowserControl = (sessionId: string, control: string) =>
      recording
        .get()
        .pipe(
          Effect.flatMap((snapshot) =>
            browserControlIsLocked(snapshot, sessionId)
              ? Effect.fail(
                  makeBrowserRpcError(
                    "recording_conflict",
                    `${control} is locked while this Recording is in progress.`
                  )
                )
              : Effect.void
          )
        );

    const requireStorageMutation = (sessionId: string) =>
      recording
        .get()
        .pipe(
          Effect.flatMap((snapshot) =>
            storageMutationIsLocked(snapshot, sessionId)
              ? Effect.fail(
                  makeBrowserRpcError(
                    "recording_conflict",
                    STORAGE_LOCKED_MESSAGE
                  )
                )
              : Effect.void
          )
        );

    // Handlers stay grouped by browser and Recording lifecycle operations.
    // oxlint-disable-next-line eslint/sort-keys
    return {
      "browser.emulation.get": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.getEmulation(data.sessionId)
        ).pipe(
          Effect.map((emulation) => ({
            data: { emulation },
            type: "browser.emulation.updated" as const,
          }))
        ),
      "browser.emulation.set": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "Emulation changes").pipe(
            Effect.andThen(
              browser.setEmulation(data.sessionId, {
                colorScheme: data.colorScheme,
                geolocation: data.geolocation,
                locale: data.locale,
                permissions: data.permissions,
                timezoneId: data.timezoneId,
              })
            )
          )
        ).pipe(
          Effect.map((emulation) => ({
            data: { emulation },
            type: "browser.emulation.updated" as const,
          }))
        ),
      "browser.frame.ack": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.acknowledgeFrame(data.sessionId, data.seq, data.streamId)
        ).pipe(Effect.as({ data: {}, type: "browser.frame.acked" as const })),
      "browser.input.send": ({ data }) =>
        genericBrowser(
          data.sessionId,
          Effect.gen(function* sendBrowserInput() {
            const snapshot = yield* recording.get();
            if (browserInputIsReadOnly(snapshot, data.sessionId)) {
              return yield* Effect.fail(
                makeBrowserRpcError(
                  "recording_conflict",
                  snapshot?.phase === "incomplete"
                    ? "The browser canvas is read-only because this Recording is incomplete. Recover or discard it to continue."
                    : "The browser canvas is read-only while Recording is paused."
                )
              );
            }
            yield* browser.sendInput(data.sessionId, data.input);
            return { data: {}, type: "browser.input.sent" as const };
          })
        ),
      "browser.navigation.run": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.navigate(data.sessionId, data.action)
        ).pipe(
          Effect.as({
            data: {},
            type: "browser.navigation.completed" as const,
          })
        ),
      "browser.network.request.get": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.getNetworkRequest(data.sessionId, data.tabId, data.requestId)
        ).pipe(
          Effect.map((request) => ({
            data: { request },
            type: "browser.network.request.result" as const,
          }))
        ),
      "browser.network.requests.get": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.getNetworkRequests(data.sessionId, data.tabId)
        ).pipe(
          Effect.map((requests) => ({
            data: { requests },
            type: "browser.network.requests.result" as const,
          }))
        ),
      "browser.open": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.open(data.sessionId, data.url, data.emulation)
        ).pipe(
          Effect.map(({ sessionId, url }) => ({
            data: { sessionId, url },
            type: "browser.opened" as const,
          }))
        ),
      "browser.session.attach": ({ data }) =>
        genericBrowser(data.sessionId, browser.currentUrl(data.sessionId)).pipe(
          Effect.map((url) => ({
            data: { sessionId: data.sessionId, url },
            type: "browser.session.attached" as const,
          }))
        ),
      "browser.session.close": ({ data }) =>
        genericBrowser(data.sessionId, browser.close(data.sessionId)).pipe(
          Effect.as({ data: {}, type: "browser.session.closed" as const })
        ),
      "browser.session.create": ({ data }) =>
        browser.create(data.name, data.viewport).pipe(
          Effect.map((sessionId) => ({
            data: { sessionId },
            type: "browser.session.created" as const,
          }))
        ),
      "browser.sessions.get": () =>
        browser.list().pipe(
          Effect.flatMap(filterGenericBrowserSessions),
          Effect.map((sessions) => ({
            data: {
              sessions: sessions.map((id) => ({ id, selected: false })),
            },
            type: "browser.sessions.result" as const,
          }))
        ),
      "browser.storage.clear": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireStorageMutation(data.sessionId).pipe(
            Effect.andThen(
              browser.clearStorage(data.sessionId, data.tabId, data.kind)
            )
          )
        ).pipe(
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.delete": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireStorageMutation(data.sessionId).pipe(
            Effect.andThen(
              browser.deleteStorage(data.sessionId, data.tabId, data)
            )
          )
        ).pipe(
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.get": ({ data }) =>
        genericBrowser(
          data.sessionId,
          browser.getStorage(data.sessionId, data.tabId, data.kind)
        ).pipe(
          Effect.map((snapshot) => ({
            data: { snapshot },
            type: "browser.storage.result" as const,
          }))
        ),
      "browser.storage.set": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireStorageMutation(data.sessionId).pipe(
            Effect.andThen(browser.setStorage(data.sessionId, data.tabId, data))
          )
        ).pipe(
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.stream.subscribe": ({ data }) =>
        Stream.unwrap(
          genericBrowser(
            data.sessionId,
            Effect.succeed(browser.stream(data.sessionId))
          )
        ),
      "browser.tab.close": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "Tab changes").pipe(
            Effect.andThen(browser.closeTab(data.sessionId, data.tabId))
          )
        ).pipe(Effect.as({ data: {}, type: "browser.tab.closed" as const })),
      "browser.tab.new": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "Tab changes").pipe(
            Effect.andThen(browser.newTab(data.sessionId))
          )
        ).pipe(Effect.as({ data: {}, type: "browser.tab.created" as const })),
      "browser.tab.switch": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "Tab changes").pipe(
            Effect.andThen(browser.switchTab(data.sessionId, data.tabId))
          )
        ).pipe(Effect.as({ data: {}, type: "browser.tab.switched" as const })),
      "browser.tabs.get": ({ data }) =>
        genericBrowser(data.sessionId, browser.getTabs(data.sessionId)).pipe(
          Effect.map((tabs) => ({
            data: { tabs },
            type: "browser.tabs.result" as const,
          }))
        ),
      "browser.user-agent.set": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "User agent changes").pipe(
            Effect.andThen(
              browser.setUserAgent(
                data.sessionId,
                data.url,
                data.viewport,
                data.userAgentProfile
              )
            )
          )
        ).pipe(
          Effect.map(({ url }) => ({
            data: { url, userAgentProfile: data.userAgentProfile },
            type: "browser.user-agent.updated" as const,
          }))
        ),
      "browser.viewport.set": ({ data }) =>
        genericBrowser(
          data.sessionId,
          requireBrowserControl(data.sessionId, "Viewport changes").pipe(
            Effect.andThen(browser.setViewport(data.sessionId, data.viewport))
          )
        ).pipe(
          Effect.as({
            data: { viewport: data.viewport },
            type: "browser.viewport.updated" as const,
          })
        ),
      "recording.audit.add": ({ data }) =>
        recordingResult(recording.addAudit(data.audit)),
      "recording.capture.cancel": () =>
        recordingResult(recording.cancelCaptureMode()),
      "recording.discard": () =>
        recording
          .discard()
          .pipe(Effect.as({ data: {}, type: "recording.discarded" as const })),
      "recording.finish": () => recordingResult(recording.finish()),
      "recording.get": () =>
        recording.get().pipe(
          Effect.map((snapshot) => ({
            data: { recording: snapshot },
            type: "recording.result" as const,
          }))
        ),
      "recording.hover.arm": () => recordingResult(recording.armHover()),
      "recording.pause": () => recordingResult(recording.pause()),
      "recording.pre-step.arm": ({ data }) =>
        recordingResult(
          recording.armPreStep(
            data.scope === "flow"
              ? { type: "flow" }
              : { stepId: data.stepId, type: "step" }
          )
        ),
      "recording.pre-step.condition.arm": ({ data }) =>
        recordingResult(
          recording.armPreStepCondition(
            data.scope === "flow"
              ? { index: data.index, type: "flow" }
              : { index: data.index, stepId: data.stepId, type: "step" },
            data.kind
          )
        ),
      "recording.pre-step.condition.url": ({ data }) =>
        recordingResult(
          recording.setPreStepConditionUrl(
            data.scope === "flow"
              ? { index: data.index, type: "flow" }
              : { index: data.index, stepId: data.stepId, type: "step" },
            data.pattern
          )
        ),
      "recording.recover": () => recordingResult(recording.recover()),
      "recording.resume": () => recordingResult(recording.resume()),
      "recording.start": ({ data }) =>
        recordingResult(
          recording.start({ sessionId: data.sessionId, title: data.title })
        ),
      "recording.step.delete": ({ data }) =>
        recordingResult(recording.deleteStep(data.stepId)),
      "recording.step.undo": () => recordingResult(recording.undoDelete()),
      "recording.step.variable.bind": ({ data }) =>
        recordingResult(recording.bindVariable(data.stepId, data.name)),
      "recording.stream.subscribe": () => recording.changes(),
      "recording.title.update": ({ data }) =>
        recordingResult(recording.updateTitle(data.title)),
      "recording.variable.rename": ({ data }) =>
        recordingResult(recording.renameVariable(data.from, data.name)),
      "run.flow.load": ({ data }) =>
        runResult(runSession.loadFlow(data.document, data.source)),
      "run.get": () => runResult(runSession.get()),
      "run.start": () =>
        runResult(requireNoRecording.pipe(Effect.andThen(runSession.start()))),
      "run.stream.subscribe": () => runSession.changes(),
      "run.variable.answer": ({ data }) =>
        runResult(runSession.answerVariable(data.name, data.value)),
      "agent.sessions.get": () =>
        agentUnavailable((service) =>
          service.list().pipe(Effect.map((sessions) => ({ sessions })))
        ).pipe(
          Effect.map((data) => ({
            data,
            type: "agent.sessions.result" as const,
          }))
        ),
      "agent.session.start": ({ data }) =>
        agentUnavailable((service) => service.start(data)).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.started" as const,
          }))
        ),
      "agent.session.get": ({ data }) =>
        agentUnavailable((service) => service.get(data.sessionId)).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.result" as const,
          }))
        ),
      "agent.session.close": ({ data }) =>
        agentUnavailable((service) =>
          service.close(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.closed" as const,
          }))
        ),
      "agent.session.stream.subscribe": ({ data }) =>
        agentStream((service) => service.changes(data.sessionId)),
      "agent.browser.frame.ack": ({ data }) =>
        agentUnavailable((service) =>
          service.acknowledgeFrame(data.sessionId, data.frameId, data.streamId)
        ).pipe(
          Effect.as({ data: {}, type: "agent.browser.frame.acked" as const })
        ),
      "agent.browser.stream.subscribe": ({ data }) =>
        agentStream((service) => service.browserStream(data.sessionId)),
      "agent.browser.input.send": ({ data }) =>
        agentUnavailable((service) =>
          service.sendInput(data.sessionId, data.input)
        ).pipe(
          Effect.as({
            data: {},
            type: "agent.browser.input.sent" as const,
          })
        ),
      "agent.teaching.variable.input": ({ data }) =>
        agentUnavailable((service) =>
          service.enterUserVariable(
            data.sessionId,
            data.ref === undefined
              ? { value: data.value, variable: data.variable }
              : {
                  ref: data.ref,
                  value: data.value,
                  variable: data.variable,
                },
            data.operationId
          )
        ).pipe(
          Effect.map((action) => ({
            data: { action },
            type: "agent.teaching.variable.input.result" as const,
          }))
        ),
      "agent.browser.navigate": ({ data }) =>
        agentUnavailable((service) =>
          service.userNavigate(data.sessionId, data.action)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.browser.navigated" as const,
          }))
        ),
      "agent.session.takeover": ({ data }) =>
        agentUnavailable((service) =>
          service.takeover(data.sessionId, data.reason, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.takeover.started" as const,
          }))
        ),
      "agent.boundary.resolve": ({ data }) =>
        agentUnavailable((service) => service.resolveBoundary(data)).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.control.returned" as const,
          }))
        ),
      "agent.session.control.return": ({ data }) =>
        agentUnavailable((service) =>
          service.returnControl(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.control.returned" as const,
          }))
        ),
      "agent.session.variable.supply": ({ data }) =>
        agentUnavailable((service) =>
          service.supplyVariable(
            data.sessionId,
            data.name,
            data.value,
            data.operationId
          )
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.variable.supplied" as const,
          }))
        ),
      /**
       * Raising a ceiling is a direct user action and exists nowhere else: the
       * agent whose work a ceiling bounds may not extend its own budget
       * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
       */
      "agent.run.ceiling.extend": ({ data }) =>
        agentUnavailable((service) =>
          service.extendCeiling(
            data.sessionId,
            data.scope,
            data.additionalMs,
            data.operationId
          )
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.result" as const,
          }))
        ),
      "agent.run.summary.get": ({ data }) =>
        Effect.gen(function* readRunSummary() {
          const summary = yield* runStoreUnavailable((store) =>
            store.read(data.runId)
          );
          const viewUrl = yield* agentUnavailable((service) =>
            service.runViewUrl(data.runId)
          );
          return {
            data: { summary, viewUrl },
            type: "agent.run.summary.result" as const,
          };
        }),
      "agent.flow.revision.get": ({ data }) =>
        revisionResult(
          catalogUnavailable((catalog) =>
            catalog.get(data.agentFlowId, data.revisionId)
          )
        ),
      /**
       * The user's correction of the agent's proposal. It compiles against the
       * same Demonstration the agent compiled from, so merging, splitting,
       * renaming, and clarifying still produce Contingency-derived Evidence
       * Slices — and the resulting draft revision holds no authorization.
       */
      "agent.flow.draft.update": ({ data }) =>
        revisionResult(
          Effect.gen(function* updateDraftFromAgentView() {
            const source = yield* agentUnavailable((service) =>
              service.teachingSource(data.sessionId)
            );
            const compiled = compileAgentFlowDraft(
              data.draft,
              source.demonstration
            );
            if (Result.isFailure(compiled)) {
              return yield* Effect.fail(
                makeBrowserRpcError(
                  "agent_flow_invalid",
                  `This correction was not saved: ${compiled.failure
                    .map(
                      (diagnostic) =>
                        `${diagnostic.message} (${diagnostic.path.join(".") || "the draft"})`
                    )
                    .join(" ")}`
                )
              );
            }
            const saved = yield* catalogUnavailable((catalog) =>
              catalog.saveDraft({
                agentFlowId: data.agentFlowId,
                basedOnRevisionId: data.basedOnRevisionId,
                compiler: {
                  clientName: source.session.clientName,
                  clientVersion: source.session.clientVersion,
                },
                emulation: source.emulation,
                operationId: data.operationId,
                proposal: data.draft,
                screenshots: [
                  ...source.demonstration.screenshotContents.values(),
                ],
                slices: compiled.success,
                sourceArtifacts: {
                  retentionFile: source.retentionFile,
                  traceFile: source.traceFile,
                  videoFile: source.videoFile,
                },
                sourceSessionId: data.sessionId,
              })
            );
            yield* agentUnavailable((service) =>
              service.recordDraft(data.sessionId, {
                agentFlowId: saved.manifest.agentFlowId,
                revisionId: saved.manifest.revisionId,
                savedAt: saved.manifest.createdAt,
                steps: saved.manifest.steps.map((step, index) => ({
                  confirmation: step.confirmation,
                  description: step.description,
                  evidenceHash: step.evidence.hash,
                  firstActionId: step.firstActionId,
                  index,
                  lastActionId: step.lastActionId,
                  name: step.name,
                })),
                title: saved.manifest.title,
              })
            );
            yield* agentUnavailable((service) =>
              service.recordPendingDecisionState(
                data.sessionId,
                saved.heads.pendingDecisions,
                saved.heads.decisionHistory
              )
            );
            return saved;
          })
        ),
      /**
       * The two gestures no MCP tool can reach. They are handlers on Agent
       * View's loopback RPC and nowhere else
       * (ADR 0027).
       */
      "agent.flow.verification.authorize": ({ data }) =>
        revisionResult(
          Effect.gen(function* authorizeVerificationRun() {
            // Where Agent View stands when the user authorizes is where the
            // Verification Run should open. A session that has gone away, or
            // that never left a blank page, simply carries no starting URL.
            const sessionId = data.sessionId ?? null;
            const startingUrl =
              sessionId === null
                ? null
                : yield* agentUnavailable((service) =>
                    service
                      .get(sessionId)
                      .pipe(
                        Effect.map((session) =>
                          verificationStartingUrl(session.currentUrl)
                        )
                      )
                  ).pipe(Effect.orElseSucceed(() => null));
            return yield* catalogUnavailable((catalog) =>
              catalog.authorizeVerification({
                agentFlowId: data.agentFlowId,
                operationId: data.operationId,
                revisionId: data.revisionId,
                startingUrl,
              })
            );
          })
        ),
      "agent.flow.approve": ({ data }) =>
        revisionResult(
          catalogUnavailable((catalog) =>
            catalog.approve({
              agentFlowId: data.agentFlowId,
              operationId: data.operationId,
              revisionId: data.revisionId,
            })
          )
        ),
      "agent.flow.archive": ({ data }) =>
        revisionResult(
          catalogUnavailable((catalog) =>
            catalog.setArchived({
              agentFlowId: data.agentFlowId,
              archived: data.archived,
              expectedHeads: data.expectedHeads,
              operationId: data.operationId,
            })
          )
        ),
      "agent.flow.delete": ({ data }) =>
        catalogUnavailable((catalog) =>
          catalog.deletePermanently({
            agentFlowId: data.agentFlowId,
            confirmation: data.confirmation,
            expectedHeads: data.expectedHeads,
            operationId: data.operationId,
          })
        ).pipe(
          Effect.map((deleted) => ({
            data: deleted,
            type: "agent.flow.deleted" as const,
          }))
        ),
    };
  })
);

const makeOriginMiddleware = (allowedOrigins: ReadonlySet<string>) =>
  HttpRouter.middleware(
    Effect.succeed((httpEffect) =>
      Effect.gen(function* validateRpcOrigin() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { origin } = request.headers;
        return isAllowedWebSocketOrigin(origin, allowedOrigins)
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
      })
    )
  ).layer;

/**
 * Reject DNS-rebinding requests before an RPC handler sees them. A process
 * bound to loopback can still receive a remote page's attacker-controlled
 * Host header, so the transport checks Host as well as browser Origin.
 */
export const makeHostMiddleware = (allowedOrigins: ReadonlySet<string>) =>
  HttpRouter.middleware(
    Effect.succeed((httpEffect) =>
      Effect.gen(function* validateRpcHost() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return isAllowedHost(request.headers.host, allowedOrigins)
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 404 });
      })
    )
  ).layer;

export interface RpcRoutesOptions<
  Requirements = FileSystem.FileSystem | RunnerService,
> {
  readonly allowedOrigins: ReadonlySet<string>;
  /** The Run this process was opened on, shared with the artifact route. */
  readonly runSession: Layer.Layer<RunSessionService, never, Requirements>;
}

export const makeRpcRoutes = <Requirements>({
  allowedOrigins,
  runSession,
}: RpcRoutesOptions<Requirements>) =>
  RpcServer.layerHttp({
    group: ContingencyRpcs,
    path: "/ws",
  }).pipe(
    Layer.provide(RpcHandlersLive.pipe(Layer.provide(runSession))),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(makeOriginMiddleware(allowedOrigins)),
    Layer.provide(makeHostMiddleware(allowedOrigins))
  );
