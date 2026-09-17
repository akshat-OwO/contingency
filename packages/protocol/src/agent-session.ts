import { Effect, Schema } from "effect";

import { AgentExecutionBoundary, AgentTimelineEntry } from "./agent-browser.ts";
import {
  AgentPendingDecision,
  AgentPendingDecisionResolution,
} from "./agent-decision.ts";
import {
  AgentProcessId,
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { AgentRunState } from "./agent-run.ts";
import { DraftEmulation } from "./emulation.ts";
import { optionalNullable } from "./optional-field.ts";
import {
  FlowSkillName,
  TeachingCaptureState,
  TeachingProgress,
  TeachingRecordingCleanupState,
  TeachingRecordingId,
} from "./teaching-recording.ts";
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
const AgentSessionSnapshotBase = {
  activity: AgentSessionActivity,
  boundary: Schema.optional(Schema.NullOr(AgentExecutionBoundary)),
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
  controller: AgentSessionController,
  createdAt: nonEmptyString,
  currentUrl: Schema.String,
  /** Resolved decisions, for the Workspace's read-only status. */
  decisionHistory: Schema.Array(AgentPendingDecisionResolution).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  error: optionalNullable(Schema.String),
  id: AgentSessionId,
  /**
   * The action the browser had already been asked to perform when Takeover
   * interrupted it. Contingency cannot undo a dispatched effect, so Agent View
   * discloses it rather than presenting Takeover as a rollback.
   */
  interruptedAction: Schema.NullOr(AgentTimelineEntry),
  ownerProcessId: AgentProcessId,
  /** Open conversation-relayed decisions associated with this session. */
  pendingDecisions: Schema.Array(AgentPendingDecision).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  phase: AgentSessionPhase,
  takeover: Schema.NullOr(AgentTakeoverRequest),
  /** The most recent attempts, oldest first, in the order they were made. */
  timeline: Schema.Array(AgentTimelineEntry),
  updatedAt: nonEmptyString,
  viewUrl: nonEmptyString,
};

export const TeachingSessionSnapshot = Schema.Struct({
  ...AgentSessionSnapshotBase,
  activity: Schema.Literal("teaching"),
  captureState: TeachingCaptureState,
  flowSkillName: FlowSkillName,
  recordingCleanup: optionalNullable(TeachingRecordingCleanupState),
  recordingId: TeachingRecordingId,
  run: Schema.Null,
  teaching: TeachingProgress,
});
export type TeachingSessionSnapshot = typeof TeachingSessionSnapshot.Type;

export const RunSessionSnapshot = Schema.Struct({
  ...AgentSessionSnapshotBase,
  activity: Schema.Literal("run"),
  captureState: Schema.Null,
  flowSkillName: Schema.Null,
  recordingId: Schema.Null,
  run: Schema.NullOr(AgentRunState),
  teaching: Schema.Null,
});
export type RunSessionSnapshot = typeof RunSessionSnapshot.Type;

export const AgentSessionSnapshot = Schema.Union([
  TeachingSessionSnapshot,
  RunSessionSnapshot,
]);
export type AgentSessionSnapshot = typeof AgentSessionSnapshot.Type;

export const AgentSessions = Schema.Struct({
  sessions: Schema.Array(AgentSessionSnapshot),
});
export type AgentSessions = typeof AgentSessions.Type;

export const AgentSessionStart = Schema.Struct({
  activity: optionalNullable(AgentSessionActivity),
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
  /**
   * The whole Emulation the session runs under — browser identity, viewport,
   * and environment together. Its viewport is the session's viewport, so a
   * phone profile is a phone rather than a narrow desktop window. Without it
   * the session runs the default identity at `viewport`.
   */
  emulation: optionalNullable(DraftEmulation),
  name: optionalNullable(nonEmptyString),
  operationId: OperationId,
  url: optionalNullable(nonEmptyString),
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
