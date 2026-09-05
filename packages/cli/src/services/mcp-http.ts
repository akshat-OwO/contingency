import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";

import { makeHostMiddleware } from "../routes/rpc.ts";
import { McpAgentFlowLayer } from "./mcp-agent-flow.ts";
import { McpAgentRunLayer } from "./mcp-agent-run.ts";
import { McpAgentSessionLayer } from "./mcp-agent-session.ts";

/** Streamable HTTP path Cursor and other URL MCP clients POST to. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * One MCP server on the Agent View HTTP router. Cursor connects by URL so it
 * does not spawn a process, or walk ports, on every CLI or app session.
 */
export const makeMcpHttpLayer = (allowedOrigins: ReadonlySet<string>) =>
  Layer.mergeAll(
    McpServer.layerHttp({
      allowedOrigins: [...allowedOrigins],
      name: "Contingency",
      path: MCP_HTTP_PATH,
      protocols: [McpProtocol.v2025_06_18],
      version: "0.0.1",
    }),
    McpAgentSessionLayer,
    McpAgentFlowLayer,
    McpAgentRunLayer
  ).pipe(Layer.provide(makeHostMiddleware(allowedOrigins)));
