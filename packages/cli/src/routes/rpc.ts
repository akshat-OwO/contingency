import { ContingencyRpcs } from "@contingency/protocol";
import { Effect, Layer, Stream } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { AgentBrowser } from "../services/agent-browser";

const RpcHandlersLive = ContingencyRpcs.toLayer(
  Effect.gen(function* makeRpcHandlers() {
    const agentBrowser = yield* AgentBrowser;

    return {
      "browser.frame.ack": ({ data }) =>
        agentBrowser
          .acknowledgeFrame(data.sessionId, data.seq)
          .pipe(Effect.as({ data: {}, type: "browser.frame.acked" as const })),
      "browser.input.send": ({ data }) =>
        agentBrowser
          .sendInput(data.sessionId, data.input)
          .pipe(Effect.as({ data: {}, type: "browser.input.sent" as const })),
      "browser.navigation.run": ({ data }) =>
        agentBrowser.navigate(data.sessionId, data.action).pipe(
          Effect.as({
            data: {},
            type: "browser.navigation.completed" as const,
          })
        ),
      "browser.network.request.get": ({ data }) =>
        agentBrowser
          .getNetworkRequest(data.sessionId, data.tabId, data.requestId)
          .pipe(
            Effect.map((request) => ({
              data: { request },
              type: "browser.network.request.result" as const,
            }))
          ),
      "browser.network.requests.get": ({ data }) =>
        agentBrowser.getNetworkRequests(data.sessionId, data.tabId).pipe(
          Effect.map((requests) => ({
            data: { requests },
            type: "browser.network.requests.result" as const,
          }))
        ),
      "browser.open": ({ data }) =>
        agentBrowser
          .open(data.sessionId, data.url, data.viewport, data.userAgentProfile)
          .pipe(
            Effect.map(({ sessionId, url }) => ({
              data: { sessionId, url },
              type: "browser.opened" as const,
            }))
          ),
      "browser.session.attach": ({ data }) =>
        agentBrowser.currentUrl(data.sessionId).pipe(
          Effect.map((url) => ({
            data: { sessionId: data.sessionId, url },
            type: "browser.session.attached" as const,
          }))
        ),
      "browser.session.close": ({ data }) =>
        agentBrowser
          .close(data.sessionId)
          .pipe(
            Effect.as({ data: {}, type: "browser.session.closed" as const })
          ),
      "browser.session.create": ({ data }) =>
        agentBrowser.create(data.name, data.viewport).pipe(
          Effect.map((sessionId) => ({
            data: { sessionId },
            type: "browser.session.created" as const,
          }))
        ),
      "browser.sessions.get": () =>
        agentBrowser.list().pipe(
          Effect.map((sessions) => ({
            data: {
              sessions: sessions.map((id) => ({ id, selected: false })),
            },
            type: "browser.sessions.result" as const,
          }))
        ),
      "browser.stream.subscribe": ({ data }) =>
        Stream.unwrap(
          agentBrowser
            .attach(data.sessionId)
            .pipe(Effect.map(() => agentBrowser.stream(data.sessionId)))
        ),
      "browser.tab.close": ({ data }) =>
        agentBrowser
          .closeTab(data.sessionId, data.tabId)
          .pipe(Effect.as({ data: {}, type: "browser.tab.closed" as const })),
      "browser.tab.new": ({ data }) =>
        agentBrowser
          .newTab(data.sessionId)
          .pipe(Effect.as({ data: {}, type: "browser.tab.created" as const })),
      "browser.tab.switch": ({ data }) =>
        agentBrowser
          .switchTab(data.sessionId, data.tabId)
          .pipe(Effect.as({ data: {}, type: "browser.tab.switched" as const })),
      "browser.tabs.get": ({ data }) =>
        agentBrowser.getTabs(data.sessionId).pipe(
          Effect.map((tabs) => ({
            data: { tabs },
            type: "browser.tabs.result" as const,
          }))
        ),
      "browser.user-agent.set": ({ data }) =>
        agentBrowser
          .setUserAgent(
            data.sessionId,
            data.url,
            data.viewport,
            data.userAgentProfile
          )
          .pipe(
            Effect.map(({ url }) => ({
              data: { url, userAgentProfile: data.userAgentProfile },
              type: "browser.user-agent.updated" as const,
            }))
          ),
      "browser.viewport.set": ({ data }) =>
        agentBrowser.setViewport(data.sessionId, data.viewport).pipe(
          Effect.as({
            data: { viewport: data.viewport },
            type: "browser.viewport.updated" as const,
          })
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

        return origin !== undefined && allowedOrigins.has(origin)
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
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
    Layer.provide(makeOriginMiddleware(allowedOrigins))
  );
