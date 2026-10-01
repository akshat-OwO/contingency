import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import {
  MCP_HTTP_PATH,
  makeMcpHttpLayer,
} from "../../src/services/mcp-http.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const BASE_URL = "http://127.0.0.1:7783";

/** Serves the production MCP HTTP layer on an ephemeral loopback port. */
export const servingMcpHttp = Effect.fn("servingMcpHttp")(
  function* servingMcpHttp(options: { readonly codeMode?: boolean } = {}) {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped();
    const allowedOrigins = new Set([BASE_URL]);
    const context = yield* Layer.build(
      HttpRouter.serve(makeMcpHttpLayer(allowedOrigins, options)).pipe(
        Layer.provide(
          Layer.mergeAll(
            makeAgentSessionLayer({
              allowedActivity: "any",
              baseUrl: BASE_URL,
            }),
            makeFlowSkillCatalogLayer({ root: catalogRoot }),
            makeAgentRunStoreLayer({ root: () => catalogRoot }),
            makeTeachingRecordingStoreLayer({ root: () => catalogRoot })
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
    const { address } = Context.get(context, HttpServer.HttpServer);
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die("Expected a TCP server.");
    }
    return `http://127.0.0.1:${address.port}`;
  }
);

/** A JSON value an MCP client sends. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface JsonRpcRequest {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: { readonly [key: string]: JsonValue };
}

const post = (
  origin: string,
  headers: Readonly<Record<string, string>>,
  body: JsonRpcRequest
) =>
  Effect.promise(() =>
    fetch(`${origin}${MCP_HTTP_PATH}`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    })
  );

/**
 * Initializes a stateful MCP session and returns a JSON-RPC caller bound to
 * it. Every call answers with the parsed JSON-RPC response body.
 */
export const connectMcp = Effect.fn("connectMcp")(function* connectMcp(
  origin: string,
  protocolVersion = "2025-06-18"
) {
  const initialized = yield* post(
    origin,
    { "mcp-protocol-version": protocolVersion },
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "verify", version: "1.0" },
        protocolVersion,
      },
    }
  );
  const headers = {
    "mcp-protocol-version": protocolVersion,
    "mcp-session-id": initialized.headers.get("mcp-session-id") ?? "",
  };
  let id = 1;
  const request = (
    method: string,
    params: { readonly [key: string]: JsonValue }
  ) =>
    Effect.gen(function* requestMcp() {
      id += 1;
      const response = yield* post(origin, headers, {
        id,
        jsonrpc: "2.0",
        method,
        params,
      });
      const body: unknown = yield* Effect.promise(() => response.json());
      return body;
    });
  const initializeBody: unknown = yield* Effect.promise(() =>
    initialized.json()
  );
  return { initialized: initializeBody, request };
});

const STATELESS_REVISION = "2026-07-28";

/**
 * A caller for the stateless 2026-07-28 revision. It never initializes; each
 * request carries its own protocol metadata and routing headers.
 */
export const statelessMcp = (origin: string) => {
  let id = 0;
  return (
    method: string,
    params: { readonly [key: string]: JsonValue },
    routingName?: string
  ) =>
    Effect.gen(function* requestStatelessMcp() {
      id += 1;
      const routing = {
        "mcp-method": method,
        "mcp-protocol-version": STATELESS_REVISION,
      };
      const headers =
        routingName === undefined
          ? routing
          : { ...routing, "mcp-name": routingName };
      const response = yield* post(origin, headers, {
        id,
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "verify",
              version: "1.0",
            },
            "io.modelcontextprotocol/protocolVersion": STATELESS_REVISION,
          },
        },
      });
      const body: unknown = yield* Effect.promise(() => response.json());
      return { body, status: response.status };
    });
};
