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
  AgentVariableEnter,
} from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import type { AgentSessionError } from "./agent-session.ts";
import { AgentSession } from "./agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

const AgentSessionStartParameters = Schema.Struct({
  activity: AgentSessionStart.fields.activity,
  clientName: AgentSessionStart.fields.clientName,
  clientVersion: AgentSessionStart.fields.clientVersion,
  emulation: AgentSessionStart.fields.emulation,
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

/**
 * The failure an MCP client actually reads. It is an Error subclass on purpose:
 * the MCP server surfaces `error.message` only for declared failures that are
 * `instanceof Error`, and reports every other shape as "an internal server
 * error" — which tells the agent nothing about a stale reference or a timeout.
 */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentSessionFailure extends Schema.Error<AgentSessionFailure>(
  "AgentSessionFailure"
)({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (cause: AgentSessionError) =>
  new AgentSessionFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

const AgentBrowserObserveParameters = Schema.Struct({
  sessionId: AgentBrowserObserve.fields.sessionId,
});

const AgentBrowserActParameters = Schema.Struct({
  action: AgentBrowserAct.fields.action,
  intent: AgentBrowserAct.fields.intent,
  operationId: AgentBrowserAct.fields.operationId,
  sessionId: AgentBrowserAct.fields.sessionId,
});

const AgentTakeoverParameters = Schema.Struct({
  operationId: AgentSessionTakeover.fields.operationId,
  reason: AgentSessionTakeover.fields.reason,
  sessionId: AgentSessionTakeover.fields.sessionId,
});

// `agent_sessions_get` takes no arguments. An empty `Schema.Struct({})` encodes
// to `anyOf: [object, array]`, which MCP clients reject because `tools/list`
// requires `inputSchema.type` to be `"object"` — one bad entry fails the whole
// list. A `Record` of unconstrained keys encodes to a plain `{ type: "object" }`.
const AgentSessionsGetParameters = Schema.Record(Schema.String, Schema.Unknown);

/** MCP tool names use underscores; dots break common clients such as Cursor. */
const AgentSessionsGetTool = Tool.make("agent_sessions_get", {
  dependencies: [AgentSession],
  description: "List running Agent Sessions owned by this MCP process.",
  failure: AgentSessionFailure,
  parameters: AgentSessionsGetParameters,
  success: AgentSessions,
});

const AgentSessionStartTool = Tool.make("agent_session_start", {
  dependencies: [AgentSession],
  description:
    "Start a process-owned Agent Session and return its loopback Workspace URL. Pass `emulation` to run under a whole browser identity — a user agent profile such as chrome-iphone or safari-iphone, its viewport, and the environment around it — rather than a default desktop identity at `viewport`.",
  failure: AgentSessionFailure,
  parameters: AgentSessionStartParameters,
  success: AgentSessionSnapshot,
});

const AgentSessionGetTool = Tool.make("agent_session_get", {
  dependencies: [AgentSession],
  description: "Read one process-owned Agent Session.",
  failure: AgentSessionFailure,
  parameters: AgentSessionGetParameters,
  success: AgentSessionSnapshot,
});

const AgentSessionCloseTool = Tool.make("agent_session_close", {
  dependencies: [AgentSession],
  description:
    "Close an Agent Session and release its owned browser. For Teaching, this finalizes the local video and generates the PlayByPlay before the Teaching Feed becomes available.",
  failure: AgentSessionFailure,
  parameters: AgentSessionCloseParameters,
  success: AgentSessionSnapshot,
});

const AgentBrowserSnapshotTool = Tool.make("agent_browser_snapshot", {
  dependencies: [AgentSession],
  description:
    "Read a compact Browser Snapshot with short-lived element references. References expire when the Page navigates or the element leaves the document.",
  failure: AgentSessionFailure,
  parameters: AgentBrowserObserveParameters,
  success: AgentBrowserSnapshot,
});

const AgentBrowserScreenshotTool = Tool.make("agent_browser_screenshot", {
  dependencies: [AgentSession],
  description:
    "Capture a PNG screenshot of the Agent Session's Page when the accessibility representation is not enough.",
  failure: AgentSessionFailure,
  parameters: AgentBrowserObserveParameters,
  success: AgentScreenshot,
});

const AgentBrowserActTool = Tool.make("agent_browser_act", {
  dependencies: [AgentSession],
  description:
    'Perform one browser action during a Run. Teaching refuses this tool: the user demonstrates the journey and you observe it. The action belongs to the active Agent Step by default, and intent.objective may describe it in the agent\'s own words. Set intent.objectiveKind to "new" only when deliberately starting work outside the approved Agent Steps. Declare known irreversible effects in intent.irreversible. Contingency enforces Domain Scope and Confirmation Steps. An intervention means the action was refused; resolve its Pending Decision before retrying the exact operation id. A new operation id needs fresh confirmation.',
  failure: AgentSessionFailure,
  parameters: AgentBrowserActParameters,
  success: AgentActionResult,
});

const AgentTakeoverRequestTool = Tool.make("agent_session_takeover_request", {
  dependencies: [AgentSession],
  description:
    "Ask the user to take control of an Interactive Run. This pauses agent actions and answers immediately with the Workspace link; only the user can return control. Teaching has no Takeover: the user already holds the browser.",
  failure: AgentSessionFailure,
  parameters: AgentTakeoverParameters,
  success: AgentSessionSnapshot,
});

const AgentVariableEnterTool = Tool.make("agent_variable_enter", {
  dependencies: [AgentSession],
  description:
    "Enter a Variable the user supplied to this Run into one element from the latest Browser Snapshot. You name the Variable and the element; the literal value stays inside Contingency and never reaches you or the Run's artifacts. Fails until the user has supplied that Variable in Workspace.",
  failure: AgentSessionFailure,
  parameters: Schema.Struct({
    name: AgentVariableEnter.fields.name,
    operationId: AgentVariableEnter.fields.operationId,
    ref: AgentVariableEnter.fields.ref,
    sessionId: AgentVariableEnter.fields.sessionId,
  }),
  success: AgentActionResult,
});

/**
 * The external agent's whole surface. Observation, Run action, and the
 * Takeover request are MCP tools and nothing else: Workspace's loopback RPC
 * exposes only what the user does, and during Teaching that is everything ([ADR 0026](../../../../docs/adr/0026-external-agents-control-agent-flows-through-mcp.md)).
 */
export const AgentSessionTools = withStrictParameters(
  Toolkit.make(
    AgentSessionsGetTool,
    AgentSessionStartTool,
    AgentSessionGetTool,
    AgentSessionCloseTool,
    AgentBrowserSnapshotTool,
    AgentBrowserScreenshotTool,
    AgentBrowserActTool,
    AgentTakeoverRequestTool,
    AgentVariableEnterTool
  )
);

/** The handlers behind those tools, shared by MCP and its tests. */
export const AgentSessionToolHandlersLive = AgentSessionTools.toLayer({
  agent_browser_act: (params) =>
    Effect.gen(function* actInAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .act(params.sessionId, params.action, params.operationId, params.intent)
        .pipe(Effect.mapError(failure));
    }),
  agent_browser_screenshot: (params) =>
    Effect.gen(function* screenshotAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .screenshot(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  agent_browser_snapshot: (params) =>
    Effect.gen(function* snapshotAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .snapshot(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  agent_session_close: (params) =>
    Effect.gen(function* closeAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .close(params.sessionId, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  agent_session_get: (params) =>
    Effect.gen(function* getAgentSession() {
      const service = yield* AgentSession;
      return yield* service
        .get(params.sessionId)
        .pipe(Effect.mapError(failure));
    }),
  agent_session_start: (params) =>
    Effect.gen(function* startAgentSession() {
      const service = yield* AgentSession;
      return yield* service.start(params).pipe(Effect.mapError(failure));
    }),
  agent_session_takeover_request: (params) =>
    Effect.gen(function* requestAgentTakeover() {
      const service = yield* AgentSession;
      return yield* service
        .requestTakeover(params.sessionId, params.reason, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  agent_sessions_get: () =>
    Effect.gen(function* listAgentSessions() {
      const service = yield* AgentSession;
      return { sessions: yield* service.list() };
    }),
  agent_variable_enter: (params) =>
    Effect.gen(function* enterSuppliedVariable() {
      const service = yield* AgentSession;
      return yield* service
        .enterSuppliedVariable(
          params.sessionId,
          params.name,
          params.ref,
          params.operationId
        )
        .pipe(Effect.mapError(failure));
    }),
});

/** MCP's typed tool surface over the process-owned Agent Session service. */
export const McpAgentSessionLayer = McpServer.toolkit(AgentSessionTools).pipe(
  Layer.provide(AgentSessionToolHandlersLive)
);
