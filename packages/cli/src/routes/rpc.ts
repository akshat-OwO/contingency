import {
  ContingencyRpcs,
  makeBrowserRpcError,
  isBrowserRpcError,
} from "@contingency/protocol";
import type {
  AgentFlowRevision,
  BrowserRpcErrorType,
} from "@contingency/protocol";
import { Effect, Layer, Option, Stream } from "effect";
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
import {
  isAllowedHost,
  isAllowedWebSocketOrigin,
} from "../services/web-url.ts";

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

/**
 * Persisted Run evidence, read by the Workspace in summary mode and by the
 * read-only viewer `open_run` returns. It is optional for the same reason the
 * catalog is: a process serving the Workspace alone has no Run store.
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
    /**
     * Agent Flow Catalog operations exposed to the Workspace over loopback
     * RPC. The catalog is optional in a process that serves the Workspace
     * alone, so its absence is a refusal rather than a crash.
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
      "agent.flow.revision.get": ({ data }) =>
        revisionResult(
          catalogUnavailable((catalog) =>
            catalog.get(data.agentFlowId, data.revisionId)
          )
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
