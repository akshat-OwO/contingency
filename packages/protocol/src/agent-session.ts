import { Schema } from "effect";

import { Viewport } from "./viewport.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * An Agent Session is a coordination envelope, not a browser session or a
 * durable Run. Keeping its identifier separate prevents a URL selector from
 * accidentally becoming a handle to the lower-level browser API.
 */
const agentSessionIdPattern = /^agent-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const AgentSessionId = Schema.String.check(
  Schema.isPattern(agentSessionIdPattern)
).pipe(Schema.brand("@contingency/AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

/** A process ownership marker used to scope Agent View discovery. */
export const AgentProcessId = nonEmptyString.pipe(
  Schema.brand("@contingency/AgentProcessId")
);
export type AgentProcessId = typeof AgentProcessId.Type;

/** A retry-safe id supplied by the external agent on every mutation. */
export const OperationId = nonEmptyString.pipe(
  Schema.brand("@contingency/OperationId")
);
export type OperationId = typeof OperationId.Type;

export const AgentSessionActivity = Schema.Literals(["teaching", "run"]);
export type AgentSessionActivity = typeof AgentSessionActivity.Type;

export const AgentSessionPhase = Schema.Literals([
  "starting",
  "running",
  "takeover",
  "completed",
  "failed",
  "interrupted",
  "closed",
]);
export type AgentSessionPhase = typeof AgentSessionPhase.Type;

export const AgentSessionController = Schema.Literals(["agent", "user"]);
export type AgentSessionController = typeof AgentSessionController.Type;

export const AgentTakeoverRequest = Schema.Struct({
  reason: nonEmptyString,
  requestedAt: nonEmptyString,
  requestedBy: AgentSessionController,
});
export type AgentTakeoverRequest = typeof AgentTakeoverRequest.Type;

/**
 * The single state value shared by the MCP and Agent View adapters. It is
 * intentionally made entirely of protocol data: browser and Playwright
 * objects never cross this boundary.
 */
export const AgentSessionSnapshot = Schema.Struct({
  activity: AgentSessionActivity,
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
  controller: AgentSessionController,
  createdAt: nonEmptyString,
  currentUrl: Schema.String,
  error: Schema.optional(Schema.String),
  id: AgentSessionId,
  ownerProcessId: AgentProcessId,
  phase: AgentSessionPhase,
  takeover: Schema.NullOr(AgentTakeoverRequest),
  updatedAt: nonEmptyString,
  viewUrl: nonEmptyString,
});
export type AgentSessionSnapshot = typeof AgentSessionSnapshot.Type;

export const AgentSessions = Schema.Struct({
  sessions: Schema.Array(AgentSessionSnapshot),
});
export type AgentSessions = typeof AgentSessions.Type;

export const AgentSessionStart = Schema.Struct({
  activity: Schema.optional(AgentSessionActivity),
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
  name: Schema.optional(nonEmptyString),
  operationId: OperationId,
  url: Schema.optional(nonEmptyString),
  viewport: Viewport,
});
export type AgentSessionStart = typeof AgentSessionStart.Type;

export const AgentSessionStartResult = Schema.Struct({
  session: AgentSessionSnapshot,
});
export type AgentSessionStartResult = typeof AgentSessionStartResult.Type;

export const AgentSessionGet = Schema.Struct({
  sessionId: AgentSessionId,
});
export type AgentSessionGet = typeof AgentSessionGet.Type;

export const AgentSessionGetResult = Schema.Struct({
  session: AgentSessionSnapshot,
});
export type AgentSessionGetResult = typeof AgentSessionGetResult.Type;

export const AgentSessionClose = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentSessionClose = typeof AgentSessionClose.Type;

export const AgentSessionCloseResult = Schema.Struct({
  session: AgentSessionSnapshot,
});
export type AgentSessionCloseResult = typeof AgentSessionCloseResult.Type;

export const AgentSessionTakeover = Schema.Struct({
  operationId: OperationId,
  reason: nonEmptyString,
  sessionId: AgentSessionId,
});
export type AgentSessionTakeover = typeof AgentSessionTakeover.Type;

export const AgentSessionReturnControl = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentSessionReturnControl = typeof AgentSessionReturnControl.Type;

export const AgentSessionStreamSubscribe = Schema.Struct({
  sessionId: AgentSessionId,
});
export type AgentSessionStreamSubscribe =
  typeof AgentSessionStreamSubscribe.Type;
