import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";

import { makeHostMiddleware } from "../routes/rpc.ts";
import type { DemoSiteService } from "./demo-site.ts";
import {
  AgentRunToolHandlersLive,
  AgentRunTools,
  McpAgentRunLayer,
} from "./mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
  McpAgentSessionLayer,
} from "./mcp-agent-session.ts";
import { McpAuthoringSkillsLayer } from "./mcp-authoring-skills.ts";
import {
  BrowserDevtoolsTools,
  BrowserDevtoolsToolHandlersLive,
} from "./mcp-browser-devtools.ts";
import {
  AgentCatalogToolHandlersLive,
  AgentCatalogTools,
  McpAgentCatalogLayer,
} from "./mcp-catalog.ts";
import {
  makeMcpCodeInterpreterLayer,
  operationSource,
} from "./mcp-code-interpreter.ts";
import {
  DeviceWorkspaceToolHandlersLive,
  DeviceWorkspaceTools,
  McpDeviceWorkspaceLayer,
} from "./mcp-device-workspace.ts";
import {
  DocsToolHandlersLive,
  DocsTools,
  McpDocsResourcesLayer,
} from "./mcp-docs.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
  makeMcpStartLayer,
} from "./mcp-onboarding.ts";
import {
  McpPursuitLayer,
  PursuitToolHandlersLive,
  PursuitTools,
} from "./mcp-pursuit.ts";
import {
  McpTeachingRecordingLayer,
  TeachingRecordingToolHandlersLive,
  TeachingRecordingTools,
} from "./mcp-teaching-recording.ts";
import { DEFAULT_MCP_INTERFACE } from "./settings.ts";
import type { McpInterface } from "./settings.ts";
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

export interface McpCatalogOptions<R> {
  readonly demoSite?: Layer.Layer<DemoSiteService, never, R> | undefined;
  readonly interface?: McpInterface | undefined;
  readonly systemOne?: SystemOneConfig | undefined;
}

/**
 * Every tool, resource, and prompt one server registers, shared by the stdio
 * and HTTP adapters so both offer the same catalog.
 */
export const makeMcpCatalogLayer = <R = never>(
  options: McpCatalogOptions<R> = {}
) => {
  if ((options.interface ?? DEFAULT_MCP_INTERFACE) === "native") {
    return Layer.mergeAll(
      McpAgentSessionLayer,
      McpDeviceWorkspaceLayer,
      McpAgentCatalogLayer,
      McpAgentRunLayer,
      McpTeachingRecordingLayer,
      McpAuthoringSkillsLayer,
      McpDocsResourcesLayer,
      makeMcpStartLayer(options.demoSite),
      makeMcpPursuitLayer(options.systemOne)
    );
  }
  const { demoSite, systemOne } = options;
  return Layer.mergeAll(
    McpAuthoringSkillsLayer,
    McpDocsResourcesLayer,
    makeMcpStartLayer(demoSite, { exampleTool: false }),
    makeMcpCodeInterpreterLayer(
      Layer.mergeAll(
        operationSource(DocsTools, DocsToolHandlersLive),
        operationSource(AgentSessionTools, AgentSessionToolHandlersLive),
        operationSource(BrowserDevtoolsTools, BrowserDevtoolsToolHandlersLive),
        operationSource(DeviceWorkspaceTools, DeviceWorkspaceToolHandlersLive),
        operationSource(AgentCatalogTools, AgentCatalogToolHandlersLive),
        operationSource(AgentRunTools, AgentRunToolHandlersLive),
        operationSource(
          TeachingRecordingTools,
          TeachingRecordingToolHandlersLive
        ),
        demoSite === undefined
          ? Layer.empty
          : operationSource(OnboardingTools, OnboardingToolHandlersLive).pipe(
              Layer.provide(demoSite)
            ),
        systemOne === undefined
          ? Layer.empty
          : operationSource(PursuitTools, PursuitToolHandlersLive).pipe(
              Layer.provide(makeSystemOneLayer(systemOne))
            )
      )
    )
  );
};

/** Streamable HTTP path Cursor and other URL MCP clients POST to. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * The same habits for the single-tool interface, where each tool named above
 * is an operation a program awaits rather than a tool the host calls.
 */
const makeSingleToolInstructions = (
  channel: boolean,
  systemOne?: SystemOneConfig
) =>
  [
    "Contingency drives a local browser and Android device for Teaching, Runs, and Dry Runs through one tool, agent_code_execute.",
    'Each program runs fresh; Agent Sessions and Runs persist. Search signatures first in their own program, e.g. return search({ query: "session" }), then call operations as await tools.<name>(input).',
    "Share viewUrl as a clickable Workspace link before acting in a new session, and whenever you need user input.",
    'Pass view:"compact" to operations that answer with a session; page older attempts and decisions with tools.agent_session_history_get.',
    "Use each action's Snapshot. Read again after effect none, unsettled state, a stale reference, or a user change.",
    "When a program ends with an intervention, present it and wait for the user; never repeat its attempt in a new program, resume only the exact boundary.",
    // Experimental (ADR 0057): only the instructions change, never the Run.
    ...(systemOne?.first === true
      ? ["Try tools.agent_browser_pursue for each Flow Skill step first."]
      : []),
    channel
      ? "On channel events, call tools.agent_session_get with meta.sessionId and meta.eventCursor as afterCursor. Otherwise wait with afterCursor and waitMs."
      : "After asking the user to act in the Workspace, call tools.agent_session_get with afterCursor and waitMs instead of asking them to report back.",
    "After your final tools.agent_run_assess, call tools.agent_run_complete.",
  ].join(" ");

/**
 * Server instructions a host loads once per connection. They carry only the
 * habits that save context or turns across every workflow; tool descriptions
 * keep the rules for each call.
 */
export const makeMcpInstructions = (
  channel = false,
  systemOne?: SystemOneConfig,
  mcpInterface: McpInterface = DEFAULT_MCP_INTERFACE
) =>
  mcpInterface === "single-tool"
    ? makeSingleToolInstructions(channel, systemOne)
    : [
        "Contingency drives a browser for Teaching, Runs, and Dry Runs.",
        "Native devtools unavailable.",
        "Share viewUrl as a Workspace link before acting in a new session or requesting user input.",
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
  options: McpCatalogOptions<R> = {}
) =>
  Layer.mergeAll(
    McpServer.layerHttp({
      allowedOrigins: [...allowedOrigins],
      instructions: makeMcpInstructions(
        false,
        options.systemOne,
        options.interface
      ),
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
    makeMcpCatalogLayer(options)
  ).pipe(Layer.provide(makeHostMiddleware(allowedOrigins)));
