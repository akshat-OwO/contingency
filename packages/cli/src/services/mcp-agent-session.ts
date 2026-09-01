import {
  AgentSessionClose,
  AgentSessionGet,
  AgentSessionSnapshot,
  AgentSessionStart,
  AgentSessions,
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

const AgentSessionTools = Toolkit.make(
  AgentSessionsGetTool,
  AgentSessionStartTool,
  AgentSessionGetTool,
  AgentSessionCloseTool
);

/** MCP's typed tool surface over the process-owned Agent Session service. */
export const McpAgentSessionLayer = McpServer.toolkit(AgentSessionTools).pipe(
  Layer.provide(
    AgentSessionTools.toLayer({
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
      "agent.sessions.get": () =>
        Effect.gen(function* listAgentSessions() {
          const service = yield* AgentSession;
          return { sessions: yield* service.list() };
        }),
    })
  )
);
