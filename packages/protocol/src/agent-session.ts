import { Schema } from "effect";

import { AgentTimelineEntry } from "./agent-browser.ts";
import { AgentSessionVerification, TeachingProgress } from "./agent-flow.ts";
import {
  AgentProcessId,
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { DraftEmulation } from "./flow.ts";
import { Viewport } from "./viewport.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

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
  /**
   * The action the browser had already been asked to perform when Takeover
   * interrupted it. Contingency cannot undo a dispatched effect, so Agent View
   * discloses it rather than presenting Takeover as a rollback.
   */
  interruptedAction: Schema.NullOr(AgentTimelineEntry),
  ownerProcessId: AgentProcessId,
  phase: AgentSessionPhase,
  takeover: Schema.NullOr(AgentTakeoverRequest),
  /**
   * What a Teaching session has captured and whether a draft has been saved
   * from it. `null` for an Interactive Run, which records no Demonstration.
   */
  teaching: Schema.NullOr(TeachingProgress),
  /** The most recent attempts, oldest first, in the order they were made. */
  timeline: Schema.Array(AgentTimelineEntry),
  updatedAt: nonEmptyString,
  /**
   * The exact draft revision this session is verifying under one spent user
   * authorization. `null` for Teaching and for an ordinary Interactive Run.
   */
  verification: Schema.NullOr(AgentSessionVerification),
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
  /**
   * The whole Emulation the session runs under — browser identity, viewport,
   * and environment together. Its viewport is the session's viewport, so a
   * phone profile is a phone rather than a narrow desktop window. Without it
   * the session runs the default identity at `viewport`.
   */
  emulation: Schema.optional(DraftEmulation),
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
