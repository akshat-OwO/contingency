import {
  AgentActionResult,
  AgentBrowserAct,
  AgentBrowserObserve,
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentSessionClose,
  AgentSessionGet,
  AgentSessionSnapshot,
  AgentSessionStart,
  AgentSessions,
  AgentSessionTakeover,
} from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import type { AgentSessionError } from "./agent-session.ts";
import { AgentSession } from "./agent-session.ts";

const AgentSessionStartParameters = Schema.Struct({
  activity: AgentSessionStart.fields.activity,
  clientName: AgentSessionStart.fields.clientName,
  clientVersion: AgentSessionStart.fields.clientVersion,
  name: AgentSessionStart.fields.name,
  operationId: AgentSessionStart.fields.operationId,
  url: AgentSessionStart.fields.url,
  viewport: AgentSessionStart.fields.viewport,
});

const AgentSessionGetParameters = Schema.Struct({
  sessionId: AgentSessionGet.fields.sessionId,
});

const AgentSessionCloseParameters = Schema.Struct({
  operationId: AgentSessionClose.fields.operationId,
  sessionId: AgentSessionClose.fields.sessionId,
});

const AgentSessionFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

const failure = (cause: AgentSessionError) => ({
  code: cause.code,
  message: cause.message,
});

const AgentBrowserObserveParameters = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
});

const AgentBrowserActParameters = Schema.Struct({
  action: AgentBrowserAct.fields.action,
  operationId: AgentBrowserAct.fields.operationId,
  sessionId: AgentBrowserAct.fields.sessionId,
});

const AgentTakeoverParameters = Schema.Struct({
  operationId: AgentSessionTakeover.fields.operationId,
  reason: AgentSessionTakeover.fields.reason,
  sessionId: AgentSessionTakeover.fields.sessionId,
});

const AgentSessionsGetTool = Tool.make("agent.sessions.get", {
  dependencies: [AgentSession],
  description: "List running Agent Sessions owned by this MCP process.",
  failure: AgentSessionFailure,
  parameters: Schema.Struct({}),
  success: AgentSessions,
});

const AgentSessionStartTool = Tool.make("agent.session.start", {
  dependencies: [AgentSession],
  description:
    "Start a process-owned Agent Session and return its loopback Agent View URL.",
  failure: AgentSessionFailure,
  parameters: AgentSessionStartParameters,
  success: AgentSessionSnapshot,
});

const AgentSessionGetTool = Tool.make("agent.session.get", {
  dependencies: [AgentSession],
  description: "Read one process-owned Agent Session.",
  failure: AgentSessionFailure,
  parameters: AgentSessionGetParameters,
  success: AgentSessionSnapshot,
});

const AgentSessionCloseTool = Tool.make("agent.session.close", {
  dependencies: [AgentSession],
  description: "Close an Agent Session and release its owned browser.",
  failure: AgentSessionFailure,
  parameters: AgentSessionCloseParameters,
  success: AgentSessionSnapshot,
});

const AgentBrowserSnapshotTool = Tool.make("agent.browser.snapshot", {
  dependencies: [AgentSession],
  description:
    "Read a compact Browser Snapshot with short-lived element references. References expire when the Page navigates or the element leaves the document.",
  failure: AgentSessionFailure,
  parameters: AgentBrowserObserveParameters,
  success: AgentBrowserSnapshot,
});

const AgentBrowserScreenshotTool = Tool.make("agent.browser.screenshot", {
  dependencies: [AgentSession],
  description:
    "Capture a PNG screenshot of the Agent Session's Page when the accessibility representation is not enough.",
  failure: AgentSessionFailure,
  parameters: AgentBrowserObserveParameters,
  success: AgentScreenshot,
});

const AgentBrowserActTool = Tool.make("agent.browser.act", {
  dependencies: [AgentSession],
  description:
    "Perform one reversible browser action on an element from the latest Browser Snapshot. Requires an operation id; repeating that id returns the original result.",
  failure: AgentSessionFailure,
  parameters: AgentBrowserActParameters,
  success: AgentActionResult,
});

const AgentTakeoverRequestTool = Tool.make("agent.session.takeover.request", {
  dependencies: [AgentSession],
  description:
    "Ask the user to take control. This pauses agent actions and answers immediately with the Agent View link; only the user can return control.",
  failure: AgentSessionFailure,
  parameters: AgentTakeoverParameters,
  success: AgentSessionSnapshot,
});

/**
 * The external agent's whole surface. Observation, action, and the Takeover
 * request are MCP tools and nothing else: Agent View's loopback RPC exposes
 * only what the user does ([ADR 0026](../../../../docs/adr/0026-external-agents-control-agent-flows-through-mcp.md)).
 */
export const AgentSessionTools = Toolkit.make(
  AgentSessionsGetTool,
  AgentSessionStartTool,
  AgentSessionGetTool,
  AgentSessionCloseTool,
  AgentBrowserSnapshotTool,
  AgentBrowserScreenshotTool,
  AgentBrowserActTool,
  AgentTakeoverRequestTool
);

/** The handlers behind those tools, shared by MCP and its tests. */
export const AgentSessionToolHandlersLive = AgentSessionTools.toLayer({
  "agent.browser.act": (params) =>
    Effect.gen(function* actInAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .act(params.sessionId, params.action, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.browser.screenshot": (params) =>
    Effect.gen(function* screenshotAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .screenshot(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.browser.snapshot": (params) =>
    Effect.gen(function* snapshotAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .snapshot(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.session.close": (params) =>
    Effect.gen(function* closeAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .close(params.sessionId, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.session.get": (params) =>
    Effect.gen(function* getAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .get(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.session.start": (params) =>
    Effect.gen(function* startAgentSession() {
      const service = yield* AgentSession;
      return yield* service.start(params).pipe(Effect.mapError(failure));
    }),
  "agent.session.takeover.request": (params) =>
    Effect.gen(function* requestAgentTakeover() {
      const service = yield* AgentSession;
      return yield* service
        .requestTakeover(params.sessionId, params.reason, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  "agent.sessions.get": () =>
    Effect.gen(function* listAgentSessions() {
      const service = yield* AgentSession;
      return { sessions: yield* service.list() };
    }),
});

/** MCP's typed tool surface over the process-owned Agent Session service. */
export const McpAgentSessionLayer = McpServer.toolkit(AgentSessionTools).pipe(
  Layer.provide(AgentSessionToolHandlersLive)
);
