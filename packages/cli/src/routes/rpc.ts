import {
  ContingencyRpcs,
  makeBrowserRpcError,
  isBrowserRpcError,
} from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect, Layer, Option, Stream } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

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

const teachingRecordingError = (
  cause: TeachingRecordingStoreError
): BrowserRpcErrorType => {
  let code: BrowserRpcErrorType["code"] = "agent_session_invalid";
  if (cause.code === "teaching_recording_not_found") {
    code = "agent_session_not_found";
  }
  if (cause.code === "teaching_recording_conflict") {
    code = "agent_session_conflict";
  }
  return makeBrowserRpcError(code, cause.message);
};

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
      operation: (
        service: TeachingRecordingStoreService
      ) => Effect.Effect<A, TeachingRecordingStoreError>
    ): Effect.Effect<A, BrowserRpcErrorType> =>
      Effect.serviceOption(TeachingRecordingStore).pipe(
        Effect.flatMap((service) =>
          Option.isSome(service)
            ? operation(service.value).pipe(
                Effect.mapError(teachingRecordingError)
              )
            : Effect.fail(
                makeBrowserRpcError(
                  "agent_session_unavailable",
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
      "agent.teaching.recording.start": ({ data }) =>
        agentUnavailable((service) =>
          service.startTeachingRecording(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.teaching.recording.started" as const,
          }))
        ),
      "agent.teaching.recording.stop": ({ data }) =>
        agentUnavailable((service) =>
          service.stopTeachingRecording(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.teaching.recording.stopped" as const,
          }))
        ),
      "agent.teaching.recording.discard": ({ data }) =>
        agentUnavailable((service) =>
          service.discardTeachingRecording(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.teaching.recording.discarded" as const,
          }))
        ),
      "agent.teaching.dry-run.stop": ({ data }) =>
        teachingRecordingUnavailable((store) =>
          Effect.gen(function* stopDryRun() {
            // Persist the stop before touching the browser. The store mutation
            // is the only lock the two processes share, so a passing report
            // that lands first wins and Stop reports the conflict instead of
            // killing a Dry Run the user already accepted.
            const manifest = yield* store.failDryRun({
              observableOutcome:
                "The user stopped the Dry Run before it completed.",
              ...data,
            });
            const { lifecycle } = manifest;
            if (lifecycle._tag === "dry-run-failed") {
              // Only the process that started the Dry Run owns its session.
              // Closing here covers a Workspace that owns it; the starting
              // process closes its own once the manifest leaves dry-running.
              yield* agentUnavailable((service) =>
                service.close(lifecycle.dryRunSessionId, data.operationId)
              ).pipe(Effect.ignore);
            }
            return {
              data: {
                captureState: manifest.lifecycle,
                cleanup: manifest.cleanup,
              },
              type: "agent.teaching.dry-run.stopped" as const,
            };
          })
        ),
      "agent.teaching.flow.reject": ({ data }) =>
        teachingRecordingUnavailable((store) => store.reject(data)).pipe(
          Effect.map((manifest) => ({
            data: {
              captureState: manifest.lifecycle,
              cleanup: manifest.cleanup,
            },
            type: "agent.teaching.flow.rejected" as const,
          }))
        ),
      "agent.teaching.flow.verify": ({ data }) =>
        teachingRecordingUnavailable((store) =>
          store.verify(data).pipe(
            Effect.andThen(store.cleanup(data)),
            Effect.map((manifest) => ({
              data: {
                captureState: manifest.lifecycle,
                cleanup: manifest.cleanup,
              },
              type: "agent.teaching.flow.verified" as const,
            }))
          )
        ),
      "agent.teaching.cleanup.retry": ({ data }) =>
        teachingRecordingUnavailable((store) => store.cleanup(data)).pipe(
          Effect.map((manifest) => ({
            data: {
              captureState: manifest.lifecycle,
              cleanup: manifest.cleanup,
            },
            type: "agent.teaching.cleanup.retried" as const,
          }))
        ),
      /*
        The Workspace's own instruction path. It is the same Teaching
        instruction the agent relays over MCP, so an inspect comment joins the
        one Demonstration rather than opening a second instruction surface.
      */
      "agent.teaching.instruction.record": ({ data }) =>
        agentUnavailable((service) =>
          service.recordInstruction(data.sessionId, data.text, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.teaching.instruction.recorded" as const,
          }))
        ),
      "agent.teaching.flow.rename": ({ data }) =>
        agentUnavailable((service) =>
          service.renameFlowSkill(data.sessionId, data.name, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.teaching.flow.renamed" as const,
          }))
        ),
      "agent.browser.element.inspect": ({ data }) =>
        agentUnavailable((service) =>
          service.inspectPoint(data.sessionId, data.x, data.y)
        ).pipe(
          Effect.map((element) => ({
            data: { element },
            type: "agent.browser.element.inspected" as const,
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
      "agent.browser.emulation.get": ({ data }) =>
        agentUnavailable((service) => service.emulation(data.sessionId)).pipe(
          Effect.map((applied) => ({
            data: applied,
            type: "agent.browser.emulation.updated" as const,
          }))
        ),
      "agent.browser.emulation.set": ({ data }) =>
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
        ).pipe(
          Effect.map((applied) => ({
            data: applied,
            type: "agent.browser.emulation.updated" as const,
          }))
        ),
      "agent.browser.tabs.get": ({ data }) =>
        agentUnavailable((service) => service.tabs(data.sessionId)).pipe(
          Effect.map((tabs) => ({
            data: { tabs },
            type: "agent.browser.tabs.result" as const,
          }))
        ),
      "agent.browser.network.requests.get": ({ data }) =>
        agentUnavailable((service) =>
          service.networkRequests(data.sessionId, data.tabId)
        ).pipe(
          Effect.map((requests) => ({
            data: { requests },
            type: "agent.browser.network.requests.result" as const,
          }))
        ),
      "agent.browser.network.request.get": ({ data }) =>
        agentUnavailable((service) =>
          service.networkRequest(data.sessionId, data.tabId, data.requestId)
        ).pipe(
          Effect.map((request) => ({
            data: { request },
            type: "agent.browser.network.request.result" as const,
          }))
        ),
      "agent.browser.storage.get": ({ data }) =>
        agentUnavailable((service) =>
          service.storage(data.sessionId, data.tabId, data.kind)
        ).pipe(
          Effect.map((snapshot) => ({
            data: { snapshot },
            type: "agent.browser.storage.result" as const,
          }))
        ),
      "agent.browser.storage.set": ({ data }) =>
        agentUnavailable((service) =>
          service.setStorage(data.sessionId, data.tabId, data)
        ).pipe(
          Effect.as({
            data: {},
            type: "agent.browser.storage.updated" as const,
          })
        ),
      "agent.browser.storage.delete": ({ data }) =>
        agentUnavailable((service) =>
          service.deleteStorage(data.sessionId, data.tabId, data)
        ).pipe(
          Effect.as({
            data: {},
            type: "agent.browser.storage.updated" as const,
          })
        ),
      "agent.browser.storage.clear": ({ data }) =>
        agentUnavailable((service) =>
          service.clearStorage(data.sessionId, data.tabId, data.kind)
        ).pipe(
          Effect.as({
            data: {},
            type: "agent.browser.storage.updated" as const,
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
      "agent.session.control.return": ({ data }) =>
        agentUnavailable((service) =>
          service.returnControl(data.sessionId, data.operationId)
        ).pipe(
          Effect.map((session) => ({
            data: { session },
            type: "agent.session.control.returned" as const,
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
  RpcServer.layerHttp({
    group: ContingencyRpcs,
    path: "/ws",
  }).pipe(
    Layer.provide(RpcHandlersLive),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(makeOriginMiddleware(allowedOrigins)),
    Layer.provide(makeHostMiddleware(allowedOrigins))
  );
