import { createServer, request } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { makeRpcRoutes } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";

const browserServices = makeAgentSessionLayer({
  baseUrl: "http://127.0.0.1:7777",
}).pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);

const serving = Effect.fn("servingRpcSecurity")(function* servingRpcSecurity() {
  const allowedOrigins = new Set(["http://127.0.0.1:7777"]);
  const context = yield* Layer.build(
    HttpRouter.serve(makeRpcRoutes({ allowedOrigins })).pipe(
      Layer.provide(browserServices),
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const { address } = server;
  if (address._tag !== "TcpAddress") {
    return yield* Effect.die("Expected a TCP server.");
  }
  return `http://127.0.0.1:${address.port}`;
});

it.live(
  "binds Agent Session RPC to loopback and rejects cross-origin HTTP and WebSocket calls",
  () =>
    Effect.gen(function* rejectsCrossOriginMutation() {
      const origin = yield* serving();
      const crossOrigin = yield* Effect.promise(() =>
        fetch(`${origin}/ws`, { headers: { origin: "https://evil.example" } })
      );
      expect(crossOrigin.status).toBe(403);
      expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();

      const allowedOrigin = yield* Effect.promise(() =>
        fetch(`${origin}/ws`, {
          headers: { origin: "http://127.0.0.1:7777" },
        })
      );
      // A GET without a WebSocket upgrade is not an RPC call, but the origin
      // passed the security boundary. No permissive CORS header is emitted.
      expect(allowedOrigin.status).not.toBe(403);
      expect(
        allowedOrigin.headers.get("access-control-allow-origin")
      ).toBeNull();

      const websocketStatus = yield* Effect.callback<number>((resume) => {
        const call = request(
          `${origin}/ws`,
          {
            headers: {
              connection: "Upgrade",
              host: new URL(origin).host,
              origin: "https://evil.example",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
              upgrade: "websocket",
            },
          },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          }
        );
        call.on("error", (cause) => resume(Effect.die(cause)));
        call.end();
      });
      expect(websocketStatus).toBe(403);

      const rebindStatus = yield* Effect.callback<number>((resume) => {
        const call = request(
          `${origin}/ws`,
          { headers: { host: "rebind.evil:7777" } },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          }
        );
        call.on("error", (cause) => resume(Effect.die(cause)));
        call.end();
      });
      expect(rebindStatus).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(browserServices)))
);
