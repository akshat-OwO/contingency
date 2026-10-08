import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { makeHostMiddleware } from "../routes/rpc.ts";
import type { DemoSiteService } from "./demo-site.ts";
import { McpAgentRunLayer } from "./mcp-agent-run.ts";
import { McpAgentSessionLayer } from "./mcp-agent-session.ts";
import { McpAuthoringSkillsLayer } from "./mcp-authoring-skills.ts";
import { McpAgentCatalogLayer } from "./mcp-catalog.ts";
import { McpCodeModeLayer } from "./mcp-code-mode.ts";
import { makeMcpStartLayer } from "./mcp-onboarding.ts";
import { McpPursuitLayer } from "./mcp-pursuit.ts";
import { McpTeachingRecordingLayer } from "./mcp-teaching-recording.ts";
import { makeSystemOneLayer } from "./system-one.ts";
import type { SystemOneConfig } from "./system-one.ts";

/**
 * `agent_browser_pursue`, only when the machine names a System One endpoint.
 * Without one the catalog is unchanged ([ADR 0057](../../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 */
export const makeMcpPursuitLayer = (systemOne: SystemOneConfig | undefined) =>
  systemOne === undefined
    ? Layer.empty
    : McpPursuitLayer.pipe(Layer.provide(makeSystemOneLayer(systemOne)));

/** Streamable HTTP path Cursor and other URL MCP clients POST to. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * Server instructions a host loads once per connection. They carry only the
 * habits that save context or turns across every workflow; tool descriptions
 * keep the rules for each call.
 */
export const makeMcpInstructions = (
  channel = false,
  systemOne?: SystemOneConfig
) =>
  [
    "Contingency drives a local browser for Teaching, Runs, and Dry Runs.",
    "Share viewUrl as a clickable Workspace link before acting in a new session, and whenever you need user input.",
    'Pass view:"compact" to tools that answer with a session; page older attempts and decisions with agent_session_history_get.',
    "Use each action's Snapshot. Read again after effect none, unsettled state, a stale reference, or a user change.",
    "Use agent_browser_act_sequence for known steps; it stops where you must look again.",
    // Experimental (ADR 0057): only the instructions change, never the Run.
    ...(systemOne?.first === true
      ? ["Try agent_browser_pursue for each Flow Skill step first."]
      : []),
    channel
      ? "On channel events, call agent_session_get with meta.sessionId and meta.eventCursor as afterCursor. Otherwise wait with afterCursor and waitMs."
      : "After asking the user to act in the Workspace, call agent_session_get with afterCursor and waitMs instead of asking them to report back.",
    "After your final agent_run_assess, call agent_run_complete.",
    "Read-only tools can run concurrently.",
  ].join(" ");

export const MCP_INSTRUCTIONS = makeMcpInstructions();

/**
 * One MCP server on the Agent View HTTP router. Cursor connects by URL so it
 * does not spawn a process, or walk ports, on every CLI or app session. The
 * demo store's onboarding surface is served only when a `demoSite` is given.
 */
export const makeMcpHttpLayer = <R = never>(
  allowedOrigins: ReadonlySet<string>,
  options: {
    readonly codeMode?: boolean | undefined;
    readonly demoSite?: Layer.Layer<DemoSiteService, never, R> | undefined;
    readonly systemOne?: SystemOneConfig | undefined;
  } = {}
) =>
  Layer.mergeAll(
    McpServer.layerHttp({
      allowedOrigins: [...allowedOrigins],
      instructions: makeMcpInstructions(false, options.systemOne),
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
    makeMcpStartLayer(options.demoSite),
    options.codeMode === true ? McpCodeModeLayer : Layer.empty,
    makeMcpPursuitLayer(options.systemOne)
  ).pipe(Layer.provide(makeHostMiddleware(allowedOrigins)));
