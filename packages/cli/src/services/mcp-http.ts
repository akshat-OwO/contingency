import { Cause, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { makeHostMiddleware } from "../routes/rpc.ts";
import type { DemoSiteService } from "./demo-site.ts";
import { AgentRunToolHandlersLive, AgentRunTools } from "./mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "./mcp-agent-session.ts";
import { McpAuthoringResourcesLayer } from "./mcp-authoring-resources.ts";
import {
  BrowserDevtoolsTools,
  BrowserDevtoolsToolHandlersLive,
} from "./mcp-browser-devtools.ts";
import {
  AgentCatalogToolHandlersLive,
  AgentCatalogTools,
} from "./mcp-catalog.ts";
import {
  makeMcpCodeInterpreterLayer,
  operationSource,
} from "./mcp-code-interpreter.ts";
import {
  DeviceWorkspaceToolHandlersLive,
  DeviceWorkspaceTools,
} from "./mcp-device-workspace.ts";
import {
  DocsToolHandlersLive,
  DocsTools,
  GETTING_STARTED_URI,
  McpDocsResourcesLayer,
} from "./mcp-docs.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
  makeMcpStartLayer,
} from "./mcp-onboarding.ts";
import type { McpProcessInfo } from "./mcp-process-info.ts";
import {
  McpProcessDiagnostics,
  defaultProcessInfo,
} from "./mcp-process-info.ts";
import { PursuitToolHandlersLive, PursuitTools } from "./mcp-pursuit.ts";
import {
  TeachingRecordingToolHandlersLive,
  TeachingRecordingTools,
} from "./mcp-teaching-recording.ts";
import { makeSystemOneLayer } from "./system-one.ts";
import type { SystemOneConfig } from "./system-one.ts";

export interface McpCatalogOptions<R> {
  readonly processInfo?: Effect.Effect<typeof McpProcessInfo.Type> | undefined;
  readonly launchContext?: string | undefined;
  readonly demoSite?: Layer.Layer<DemoSiteService, never, R> | undefined;
  readonly systemOne?: SystemOneConfig | undefined;
}

/**
 * Every tool, resource, and prompt one server registers, shared by the stdio
 * and HTTP adapters so both offer the same catalog.
 */
const makeCatalogLayer = <R = never>(options: McpCatalogOptions<R> = {}) => {
  const { demoSite, systemOne } = options;
  return Layer.mergeAll(
    McpAuthoringResourcesLayer,
    McpDocsResourcesLayer,
    makeMcpStartLayer(demoSite, {
      launchContext: options.launchContext,
    }),
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

/** The catalog receives process-owned diagnostics. */
export const makeMcpCatalogLayer = <R = never>(
  options: McpCatalogOptions<R> = {}
) =>
  makeCatalogLayer(options).pipe(
    Layer.provide(
      Layer.succeed(McpProcessDiagnostics, {
        read: options.processInfo ?? defaultProcessInfo(options.systemOne),
      })
    )
  );

/** Streamable HTTP path Cursor and other URL MCP clients POST to. */
export const MCP_HTTP_PATH = "/mcp";

/**
 * Server instructions a host loads once per connection. Operation descriptions
 * keep the rules for each call.
 */
export const makeMcpInstructions = (
  channel = false,
  systemOne?: SystemOneConfig
) =>
  [
    "Contingency drives a local browser and Android device for Teaching, Runs, and Dry Runs through one tool, agent_code_execute.",
    'Each program runs fresh; Agent Sessions and Runs persist. Search signatures first in their own program, e.g. return search({ query: "session" }), then call operations as await tools.<name>(input).',
    `Read ${GETTING_STARTED_URI} first, or tools.docs_get({ topic: "getting-started" }).`,
    "Share viewUrl as a clickable Workspace link before acting in a new session, and whenever you need user input.",
    'Pass view:"compact" to operations that answer with a session; page older attempts and decisions with tools.agent_session_history_get.',
    "Use each action's Snapshot. Read again after effect none, unsettled state, a stale reference, or a user change.",
    "When a program ends with an intervention, present it and wait for the user; never repeat its attempt in a new program, resume only the exact boundary.",
    // Experimental (ADR 0057): only the instructions change, never the Run.
    ...(systemOne?.first === true
      ? ["Try tools.agent_browser_pursue for each Flow step first."]
      : []),
    channel
      ? "On channel events, call tools.agent_session_get with meta.sessionId and meta.eventCursor as afterCursor. Otherwise wait with afterCursor and waitMs."
      : "After asking the user to act in the Workspace, call tools.agent_session_get with afterCursor and waitMs instead of asking them to report back.",
    "After your final tools.agent_run_assess, call tools.agent_run_complete.",
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
    }).pipe(
      Layer.provide(
        // Effect's MCP codec suppresses cancelled results. Its empty response
        // queue ends with Done, which is successful completion, not an HTTP error.
        HttpRouter.middleware((httpEffect) =>
          httpEffect.pipe(
            Effect.catchIf(Cause.isDone, () =>
              Effect.succeed(HttpServerResponse.empty({ status: 202 }))
            )
          )
        ).layer
      )
    ),
    makeMcpCatalogLayer(options)
  ).pipe(Layer.provide(makeHostMiddleware(allowedOrigins)));
