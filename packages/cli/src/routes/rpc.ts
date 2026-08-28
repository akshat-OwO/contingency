import {
  ContingencyRpcs,
  makeBrowserRpcError,
  recordingIsInProgress,
  recordingLocksBrowserControls,
  recordingLocksStorageMutations,
  recordingMakesBrowserInputReadOnly,
  STORAGE_LOCKED_MESSAGE,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  RecordingSnapshot,
  RunSnapshot,
} from "@contingency/protocol";
import { Effect, Layer } from "effect";
import type { FileSystem } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CreateBrowser } from "../services/create-browser.ts";
import { Recording } from "../services/recording.ts";
import { RunSession } from "../services/run-session.ts";
import type { RunSessionService } from "../services/run-session.ts";
import type { RunnerService } from "../services/runner.ts";
import { isAllowedWebSocketOrigin } from "../services/web-url.ts";

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
        browser.getEmulation(data.sessionId).pipe(
          Effect.map((emulation) => ({
            data: { emulation },
            type: "browser.emulation.updated" as const,
          }))
        ),
      "browser.emulation.set": ({ data }) =>
        requireBrowserControl(data.sessionId, "Emulation changes").pipe(
          Effect.andThen(
            browser.setEmulation(data.sessionId, {
              colorScheme: data.colorScheme,
              geolocation: data.geolocation,
              locale: data.locale,
              permissions: data.permissions,
              timezoneId: data.timezoneId,
            })
          ),
          Effect.map((emulation) => ({
            data: { emulation },
            type: "browser.emulation.updated" as const,
          }))
        ),
      "browser.frame.ack": ({ data }) =>
        browser
          .acknowledgeFrame(data.sessionId, data.seq, data.streamId)
          .pipe(Effect.as({ data: {}, type: "browser.frame.acked" as const })),
      "browser.input.send": ({ data }) =>
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
        }),
      "browser.navigation.run": ({ data }) =>
        browser.navigate(data.sessionId, data.action).pipe(
          Effect.as({
            data: {},
            type: "browser.navigation.completed" as const,
          })
        ),
      "browser.network.request.get": ({ data }) =>
        browser
          .getNetworkRequest(data.sessionId, data.tabId, data.requestId)
          .pipe(
            Effect.map((request) => ({
              data: { request },
              type: "browser.network.request.result" as const,
            }))
          ),
      "browser.network.requests.get": ({ data }) =>
        browser.getNetworkRequests(data.sessionId, data.tabId).pipe(
          Effect.map((requests) => ({
            data: { requests },
            type: "browser.network.requests.result" as const,
          }))
        ),
      "browser.open": ({ data }) =>
        browser
          .open(data.sessionId, data.url, data.viewport, data.userAgentProfile)
          .pipe(
            Effect.map(({ sessionId, url }) => ({
              data: { sessionId, url },
              type: "browser.opened" as const,
            }))
          ),
      "browser.session.attach": ({ data }) =>
        browser.currentUrl(data.sessionId).pipe(
          Effect.map((url) => ({
            data: { sessionId: data.sessionId, url },
            type: "browser.session.attached" as const,
          }))
        ),
      "browser.session.close": ({ data }) =>
        browser
          .close(data.sessionId)
          .pipe(
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
          Effect.map((sessions) => ({
            data: {
              sessions: sessions.map((id) => ({ id, selected: false })),
            },
            type: "browser.sessions.result" as const,
          }))
        ),
      "browser.storage.clear": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(
            browser.clearStorage(data.sessionId, data.tabId, data.kind)
          ),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.delete": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(
            browser.deleteStorage(data.sessionId, data.tabId, data)
          ),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.get": ({ data }) =>
        browser.getStorage(data.sessionId, data.tabId, data.kind).pipe(
          Effect.map((snapshot) => ({
            data: { snapshot },
            type: "browser.storage.result" as const,
          }))
        ),
      "browser.storage.set": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(browser.setStorage(data.sessionId, data.tabId, data)),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.stream.subscribe": ({ data }) => browser.stream(data.sessionId),
      "browser.tab.close": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(browser.closeTab(data.sessionId, data.tabId)),
          Effect.as({ data: {}, type: "browser.tab.closed" as const })
        ),
      "browser.tab.new": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(browser.newTab(data.sessionId)),
          Effect.as({ data: {}, type: "browser.tab.created" as const })
        ),
      "browser.tab.switch": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(browser.switchTab(data.sessionId, data.tabId)),
          Effect.as({ data: {}, type: "browser.tab.switched" as const })
        ),
      "browser.tabs.get": ({ data }) =>
        browser.getTabs(data.sessionId).pipe(
          Effect.map((tabs) => ({
            data: { tabs },
            type: "browser.tabs.result" as const,
          }))
        ),
      "browser.user-agent.set": ({ data }) =>
        requireBrowserControl(data.sessionId, "User agent changes").pipe(
          Effect.andThen(
            browser.setUserAgent(
              data.sessionId,
              data.url,
              data.viewport,
              data.userAgentProfile
            )
          ),
          Effect.map(({ url }) => ({
            data: { url, userAgentProfile: data.userAgentProfile },
            type: "browser.user-agent.updated" as const,
          }))
        ),
      "browser.viewport.set": ({ data }) =>
        requireBrowserControl(data.sessionId, "Viewport changes").pipe(
          Effect.andThen(browser.setViewport(data.sessionId, data.viewport)),
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
      "run.get": () => runResult(runSession.get()),
      "run.start": () =>
        runResult(requireNoRecording.pipe(Effect.andThen(runSession.start()))),
      "run.stream.subscribe": () => runSession.changes(),
      "run.variable.answer": ({ data }) =>
        runResult(runSession.answerVariable(data.name, data.value)),
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

export interface RpcRoutesOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  /** The Run this process was opened on, shared with the artifact route. */
  readonly runSession: Layer.Layer<
    RunSessionService,
    never,
    FileSystem.FileSystem | RunnerService
  >;
}

export const makeRpcRoutes = ({
  allowedOrigins,
  runSession,
}: RpcRoutesOptions) =>
  RpcServer.layerHttp({
    group: ContingencyRpcs,
    path: "/ws",
  }).pipe(
    Layer.provide(RpcHandlersLive.pipe(Layer.provide(runSession))),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(makeOriginMiddleware(allowedOrigins))
  );
