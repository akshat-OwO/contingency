import { createServer, request } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { makeAgentFlowCatalogLayer } from "../../src/services/agent-flow-catalog.ts";
import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  MCP_HTTP_PATH,
  makeMcpHttpLayer,
} from "../../src/services/mcp-http.ts";
import { RecordingLive } from "../../src/services/recorder.ts";

const initializeBody = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "verify", version: "1.0" },
    protocolVersion: "2025-06-18",
  },
});

const serving = Effect.fn("servingMcpHttp")(function* servingMcpHttp() {
  const fileSystem = yield* FileSystem.FileSystem;
  const catalogRoot = yield* fileSystem.makeTempDirectoryScoped();
  const allowedOrigins = new Set(["http://127.0.0.1:7783"]);
  const context = yield* Layer.build(
    HttpRouter.serve(makeMcpHttpLayer(allowedOrigins)).pipe(
      Layer.provide(
        Layer.mergeAll(
          makeAgentSessionLayer({ baseUrl: "http://127.0.0.1:7783" }),
          makeAgentFlowCatalogLayer({ root: catalogRoot }),
          makeAgentRunStoreLayer({ root: () => catalogRoot }),
          RecordingLive
        ).pipe(
          Layer.provideMerge(CreateBrowserLive),
          Layer.provideMerge(NodeServices.layer)
        )
      ),
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

const postMcp = (
  origin: string,
  headers: Record<string, string>,
  body: string = initializeBody
) =>
  Effect.promise(() =>
    fetch(`${origin}${MCP_HTTP_PATH}`, {
      body,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    })
  );

it.live(
  "serves Streamable HTTP MCP on a stable path so URL clients share one process",
  () =>
    Effect.gen(function* answersInitializeOverHttp() {
      const origin = yield* serving();
      const initialized = yield* postMcp(origin, {
        "mcp-protocol-version": "2025-06-18",
      });
      expect(initialized.status).toBe(200);
      const payload: unknown = yield* Effect.promise(() => initialized.json());
      expect(payload).toEqual(
        expect.objectContaining({
          id: 1,
          jsonrpc: "2.0",
          result: expect.objectContaining({
            protocolVersion: "2025-06-18",
            serverInfo: { name: "Contingency", version: "0.0.1" },
          }),
        })
      );

      const get = yield* Effect.promise(() =>
        fetch(`${origin}${MCP_HTTP_PATH}`)
      );
      expect(get.status).toBe(405);

      const crossOrigin = yield* postMcp(origin, {
        origin: "https://evil.example",
      });
      expect(crossOrigin.status).toBe(403);

      const rebound = yield* Effect.callback<number>((resume) => {
        const call = request(
          `${origin}${MCP_HTTP_PATH}`,
          {
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              host: "rebind.evil:7783",
            },
            method: "POST",
          },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          }
        );
        call.on("error", (cause) => resume(Effect.die(cause)));
        call.end(initializeBody);
      });
      expect(rebound).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
