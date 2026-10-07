import {
  ContingencyRpcs,
  makeBrowserRpcError,
  isBrowserRpcError,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { AgentRunStore } from "../services/agent-run-store.ts";
import type {
  AgentRunStoreError,
  AgentRunStoreService,
} from "../services/agent-run-store.ts";
import { AgentSession } from "../services/agent-session.ts";
import type {
  AgentSessionError,
  AgentSessionService,
} from "../services/agent-session.ts";
import { CatalogBrowser } from "../services/catalog-browser.ts";
import type {
  CatalogBrowserError,
  CatalogBrowserService,
} from "../services/catalog-browser.ts";
import {
  decideFlowSkill,
  stopDryRun,
} from "../services/teaching-recording-orchestration.ts";
import { TeachingRecordingStore } from "../services/teaching-recording-store.ts";
import type {
  TeachingRecordingStoreError,
  TeachingRecordingStoreService,
} from "../services/teaching-recording-store.ts";
import {
  isAllowedHost,
  isAllowedWebSocketOrigin,
} from "../services/web-url.ts";

const agentError = (cause: AgentSessionError): BrowserRpcErrorType =>
  isBrowserRpcError(cause)
    ? cause
    : makeBrowserRpcError(cause.code, cause.message);

const teachingRecordingErrorCodes = {
  teaching_recording_conflict: "agent_teaching_conflict",
  teaching_recording_invalid: "agent_teaching_invalid",
  teaching_recording_io: "agent_teaching_unavailable",
  teaching_recording_not_found: "agent_teaching_not_found",
  teaching_recording_unclaimed: "agent_teaching_conflict",
} as const satisfies Record<
  TeachingRecordingStoreError["code"],
  BrowserRpcErrorType["code"]
>;

export const teachingRecordingError = (
  cause: TeachingRecordingStoreError
): BrowserRpcErrorType =>
  makeBrowserRpcError(teachingRecordingErrorCodes[cause.code], cause.message);

/** The Workspace's view of a recording after a lifecycle gesture. */
const recordingState = (manifest: TeachingRecordingManifest) => ({
  captureState: manifest.lifecycle,
  cleanup: manifest.cleanup,
});

/**
 * Persisted Run evidence, read by the Workspace in summary mode and by the
 * read-only viewer `open_run` returns. It is optional because a process
 * serving the Workspace alone has no Run store.
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

/**
 * The Skills drawer's read-only catalog view. It is optional for the same
 * reason the Run store is: a process may serve no Catalog Root.
 */
const catalogBrowserUnavailable = <A>(
  operation: (
    service: CatalogBrowserService
  ) => Effect.Effect<A, CatalogBrowserError>
): Effect.Effect<A, BrowserRpcErrorType> =>
  Effect.serviceOption(CatalogBrowser).pipe(
    Effect.flatMap((service) =>
      Option.isSome(service)
        ? operation(service.value).pipe(
            Effect.mapError((cause) =>
              makeBrowserRpcError(
                cause.code === "flow_skill_not_found"
                  ? "agent_flow_not_found"
                  : "agent_catalog_invalid",
                cause.message
              )
            )
          )
        : Effect.fail(
            makeBrowserRpcError(
              "agent_catalog_invalid",
              "No Catalog Root is browsable in this server process."
            )
          )
    )
  );

export const RpcHandlersLive = ContingencyRpcs.toLayer(
  Effect.sync(() => {
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
    const teachingRecordingUnavailable = <A>(
      operation: Effect.Effect<
        A,
        TeachingRecordingStoreError,
        TeachingRecordingStoreService
      >
    ): Effect.Effect<A, BrowserRpcErrorType> =>
      Effect.serviceOption(TeachingRecordingStore).pipe(
        Effect.flatMap((service) =>
          Option.isSome(service)
            ? operation.pipe(
                Effect.provideService(TeachingRecordingStore, service.value),
                Effect.mapError(teachingRecordingError)
              )
            : Effect.fail(
                makeBrowserRpcError(
                  "agent_teaching_unavailable",
                  "Teaching Recording storage is unavailable in this server process."
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

    // Handlers stay grouped by Agent Session lifecycle rather than sorted.
    // oxlint-disable-next-line eslint/sort-keys
    return {
      "agent.sessions.get": () =>
        agentUnavailable((service) =>
          service.list().pipe(Effect.map((sessions) => ({ sessions })))
        ),
      "agent.session.start": (data) =>
        agentUnavailable((service) => service.start(data)).pipe(
          Effect.map((session) => ({ session }))
        ),
      "agent.session.get": (data) =>
        agentUnavailable((service) => service.get(data.sessionId)).pipe(
          Effect.map((session) => ({ session }))
        ),
      "agent.session.close": (data) =>
        agentUnavailable((service) =>
          service.close(data.sessionId, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.teaching.recording.start": (data) =>
        agentUnavailable((service) =>
          service.startTeachingRecording(data.sessionId, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.teaching.recording.stop": (data) =>
        agentUnavailable((service) =>
          service.stopTeachingRecording(data.sessionId, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.teaching.recording.discard": (data) =>
        agentUnavailable((service) =>
          service.discardTeachingRecording(data.sessionId, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.teaching.dry-run.stop": (data) =>
        teachingRecordingUnavailable(stopDryRun(data)).pipe(
          Effect.map(recordingState)
        ),
      "agent.teaching.flow.reject": (data) =>
        teachingRecordingUnavailable(
          decideFlowSkill({ ...data, decision: "reject" })
        ).pipe(Effect.map(recordingState)),
      "agent.teaching.flow.verify": (data) =>
        teachingRecordingUnavailable(
          decideFlowSkill({ ...data, decision: "verify" })
        ).pipe(Effect.map(recordingState)),
      "agent.teaching.cleanup.retry": (data) =>
        teachingRecordingUnavailable(
          decideFlowSkill({ ...data, decision: "retry-cleanup" })
        ).pipe(Effect.map(recordingState)),
      /*
        The Workspace's own instruction path. It is the same Teaching
        instruction the agent relays over MCP, so an inspect comment joins the
        one Demonstration rather than opening a second instruction surface.
      */
      "agent.teaching.instruction.record": (data) =>
        agentUnavailable((service) =>
          service.recordInstruction(
            data.sessionId,
            data.text,
            data.operationId,
            data.target,
            data.scan
          )
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.teaching.flow.rename": (data) =>
        agentUnavailable((service) =>
          service.renameFlowSkill(data.sessionId, data.name, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.browser.element.inspect": (data) =>
        agentUnavailable((service) =>
          service.inspectPoint(data.sessionId, data.x, data.y)
        ).pipe(Effect.map((element) => ({ element }))),
      "agent.session.stream.subscribe": (data) =>
        agentStream((service) => service.changes(data.sessionId)),
      "agent.browser.frame.ack": (data) =>
        agentUnavailable((service) =>
          service.acknowledgeFrame(data.sessionId, data.frameId, data.streamId)
        ).pipe(Effect.as({})),
      "agent.browser.stream.subscribe": (data) =>
        agentStream((service) => service.browserStream(data.sessionId)),
      "agent.browser.input.send": (data) =>
        // One at a time, in the order the user made them: the first input
        // the browser refuses ends the batch.
        agentUnavailable((service) =>
          Effect.forEach(
            data.inputs,
            (input) => service.sendInput(data.sessionId, input),
            { discard: true }
          )
        ).pipe(Effect.as({})),
      "agent.browser.emulation.get": (data) =>
        agentUnavailable((service) => service.emulation(data.sessionId)),
      "agent.browser.emulation.set": (data) =>
        agentUnavailable((service) =>
          service.setEmulation(data.sessionId, {
            colorScheme: data.colorScheme,
            geolocation: data.geolocation,
            locale: data.locale,
            permissions: data.permissions,
            timezoneId: data.timezoneId,
            userAgentProfile: data.userAgentProfile,
            viewport: data.viewport,
          })
        ),
      "agent.browser.tabs.get": (data) =>
        agentUnavailable((service) => service.tabs(data.sessionId)).pipe(
          Effect.map((tabs) => ({ tabs }))
        ),
      "agent.browser.network.requests.get": (data) =>
        agentUnavailable((service) =>
          service.networkRequests(data.sessionId, data.tabId)
        ).pipe(Effect.map((requests) => ({ requests }))),
      "agent.browser.network.request.get": (data) =>
        agentUnavailable((service) =>
          service.networkRequest(data.sessionId, data.tabId, data.requestId)
        ).pipe(Effect.map((request) => ({ request }))),
      "agent.browser.storage.get": (data) =>
        agentUnavailable((service) =>
          service.storage(data.sessionId, data.tabId, data.kind)
        ).pipe(Effect.map((snapshot) => ({ snapshot }))),
      "agent.browser.storage.set": (data) =>
        agentUnavailable((service) =>
          service.setStorage(data.sessionId, data.tabId, data)
        ).pipe(Effect.as({})),
      "agent.browser.storage.delete": (data) =>
        agentUnavailable((service) =>
          service.deleteStorage(data.sessionId, data.tabId, data)
        ).pipe(Effect.as({})),
      "agent.browser.storage.clear": (data) =>
        agentUnavailable((service) =>
          service.clearStorage(data.sessionId, data.tabId, data.kind)
        ).pipe(Effect.as({})),
      "agent.teaching.variable.input": (data) =>
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
        ).pipe(Effect.map((action) => ({ action }))),
      "agent.dry-run.variable.supply": (data) =>
        agentUnavailable((service) =>
          service.supplyDryRunVariable(data.sessionId, data.name, data.value)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.setup.variable.answer": (data) =>
        agentUnavailable((service) => service.answerSetupVariable(data)).pipe(
          Effect.map((session) => ({ session }))
        ),
      "agent.boundary.decision": ({ sessionId, ...input }) =>
        agentUnavailable((service) =>
          service.resolvePendingDecision(input, {
            source: "workspace",
            sessionId,
          })
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.dry-run.variable.answer": ({ sessionId, ...input }) =>
        agentUnavailable((service) =>
          service.answerDryRunVariable(sessionId, input)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.browser.navigate": (data) =>
        agentUnavailable((service) =>
          service.userNavigate(data.sessionId, data.action)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.session.takeover": (data) =>
        agentUnavailable((service) =>
          service.takeover(data.sessionId, data.reason, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.session.control.return": (data) =>
        agentUnavailable((service) =>
          service.returnControl(data.sessionId, data.operationId)
        ).pipe(Effect.map((session) => ({ session }))),
      "agent.run.summary.get": (data) =>
        Effect.gen(function* readRunSummary() {
          const summary = yield* runStoreUnavailable((store) =>
            store.read(data.runId)
          );
          const viewUrl = yield* agentUnavailable((service) =>
            service.runViewUrl(data.runId)
          );
          return { summary, viewUrl };
        }),
      "catalog.browse.get": () =>
        catalogBrowserUnavailable((service) => service.browse()),
      "catalog.flow-skill.get": (data) =>
        catalogBrowserUnavailable((service) =>
          service.flowSkill(data.scope, data.name)
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

export interface RpcRoutesOptions {
  readonly allowedOrigins: ReadonlySet<string>;
}

export const makeRpcRoutes = ({ allowedOrigins }: RpcRoutesOptions) =>
  Layer.merge(
    RpcServer.layerHttp({ group: ContingencyRpcs, path: "/ws" }).pipe(
      Layer.provide(RpcSerialization.layerJson)
    ),
    RpcServer.layerHttp({ group: ContingencyRpcs, path: "/ws/browser" }).pipe(
      Layer.provide(RpcSerialization.layerSchemaBinary())
    )
  ).pipe(
    Layer.provide(RpcHandlersLive),
    Layer.provide(makeOriginMiddleware(allowedOrigins)),
    Layer.provide(makeHostMiddleware(allowedOrigins))
  );
