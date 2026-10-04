import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { makeHostMiddleware } from "../routes/rpc.ts";
import { McpAgentRunLayer } from "./mcp-agent-run.ts";
import { McpAgentSessionLayer } from "./mcp-agent-session.ts";
import { McpAuthoringSkillsLayer } from "./mcp-authoring-skills.ts";
import { McpAgentCatalogLayer } from "./mcp-catalog.ts";
import { McpCodeModeLayer } from "./mcp-code-mode.ts";
import { McpOnboardingLayer } from "./mcp-onboarding.ts";
import { McpTeachingRecordingLayer } from "./mcp-teaching-recording.ts";

/** Streamable HTTP path Cursor and other URL MCP clients POST to. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * Server instructions a host loads once per connection. They carry only the
 * habits that save context or turns across every workflow; tool descriptions
 * keep the rules for each call.
 */
export const MCP_INSTRUCTIONS = [
  "Contingency drives a local browser for Teaching, Runs, and Dry Runs.",
  'Pass view:"compact" to tools that answer with a session; page older attempts and decisions with agent_session_history_get.',
  "Reason from the Snapshot each browser action returns. Read the Page again only after effect none, an unsettled Snapshot, a stale reference, or a change you did not cause.",
  "Use agent_browser_act_sequence for a few known steps on the current Page; it stops where you must look again.",
  "Tools annotated read-only are safe to call concurrently.",
  "After your final agent_run_assess, call agent_run_complete.",
].join(" ");

/**
 * One MCP server on the Agent View HTTP router. Cursor connects by URL so it
 * does not spawn a process, or walk ports, on every CLI or app session.
 */
export const makeMcpHttpLayer = (
  allowedOrigins: ReadonlySet<string>,
  options: { readonly codeMode?: boolean } = {}
) =>
  Layer.mergeAll(
    McpServer.layerHttp({
      allowedOrigins: [...allowedOrigins],
      instructions: MCP_INSTRUCTIONS,
      name: "Contingency",
      path: MCP_HTTP_PATH,
      // The first adapter answers clients that negotiate an unknown revision,
      // so existing clients keep 2025-06-18. Newer clients opt in (ADR 0045).
      protocols: [
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_11_25,
        McpProtocol.v2026_07_28,
      ],
      version: "0.0.1",
    }),
    McpAgentSessionLayer,
    McpAgentCatalogLayer,
    McpAgentRunLayer,
    McpTeachingRecordingLayer,
    McpAuthoringSkillsLayer,
    McpOnboardingLayer,
    options.codeMode === true ? McpCodeModeLayer : Layer.empty
  ).pipe(Layer.provide(makeHostMiddleware(allowedOrigins)));
