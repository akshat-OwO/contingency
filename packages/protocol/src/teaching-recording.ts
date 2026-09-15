import { Schema } from "effect";

import { EvidenceHash } from "./agent-flow.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { DraftEmulation } from "./emulation.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const TeachingRecordingId = Schema.String.check(
  Schema.isPattern(/^recording-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
).pipe(Schema.brand("@contingency/TeachingRecordingId"));
export type TeachingRecordingId = typeof TeachingRecordingId.Type;

export const FlowSkillName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u)
).pipe(Schema.brand("@contingency/FlowSkillName"));
export type FlowSkillName = typeof FlowSkillName.Type;

const Setup = Schema.TaggedStruct("setup", {
  requestedAt: nonEmptyString,
});
const Recording = Schema.TaggedStruct("recording", {
  startedAt: nonEmptyString,
});
const Finalizing = Schema.TaggedStruct("finalizing", {
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const Ready = Schema.TaggedStruct("ready", {
  readyAt: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const Learning = Schema.TaggedStruct("learning", {
  readyAt: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const SkillDrafted = Schema.TaggedStruct("skill-drafted", {
  draftedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const DryRunning = Schema.TaggedStruct("dry-running", {
  draftedAt: nonEmptyString,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const DryRunPassed = Schema.TaggedStruct("dry-run-passed", {
  draftedAt: nonEmptyString,
  dryRunEndedAt: nonEmptyString,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const Verified = Schema.TaggedStruct("verified", {
  draftedAt: nonEmptyString,
  dryRunEndedAt: nonEmptyString,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
  verifiedAt: nonEmptyString,
});
const Failed = Schema.TaggedStruct("failed", {
  error: nonEmptyString,
  failedAt: nonEmptyString,
});

export const TeachingCaptureState = Schema.Union([
  Setup,
  Recording,
  Finalizing,
  Ready,
  Learning,
  SkillDrafted,
  DryRunning,
  DryRunPassed,
  Verified,
  Failed,
]);
export type TeachingCaptureState = typeof TeachingCaptureState.Type;

export const TeachingRecordingArtifact = Schema.Struct({
  capturedAt: nonEmptyString,
  hash: EvidenceHash,
  id: nonEmptyString,
  kind: Schema.Literals(["events", "keyframe", "screenshot", "trace", "video"]),
  path: nonEmptyString,
});
export type TeachingRecordingArtifact = typeof TeachingRecordingArtifact.Type;

export const TeachingRecordingCleanupState = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("completed", { completedAt: nonEmptyString }),
]);
export type TeachingRecordingCleanupState =
  typeof TeachingRecordingCleanupState.Type;

export const TeachingRecordingOperation = Schema.Literals([
  "begin",
  "start",
  "stop",
  "start-learning",
  "save-skill",
  "start-dry-run",
  "pass-dry-run",
  "cleanup",
  "verification",
]);
export type TeachingRecordingOperation = typeof TeachingRecordingOperation.Type;

export const TeachingRecordingReceipt = Schema.Struct({
  completedAt: nonEmptyString,
  operation: TeachingRecordingOperation,
  operationId: OperationId,
});
export type TeachingRecordingReceipt = typeof TeachingRecordingReceipt.Type;

const TeachingRecordingManifestBase = {
  artifacts: Schema.Array(TeachingRecordingArtifact),
  createdAt: nonEmptyString,
  emulation: DraftEmulation,
  flowSkillName: FlowSkillName,
  receipts: Schema.Array(TeachingRecordingReceipt),
  recordingId: TeachingRecordingId,
  schemaVersion: Schema.Literal(1),
  sessionId: AgentSessionId,
  updatedAt: nonEmptyString,
};

export const TeachingRecordingManifest = Schema.Union([
  Schema.Struct({
    ...TeachingRecordingManifestBase,
    cleanup: Schema.TaggedStruct("pending", {}),
    lifecycle: TeachingCaptureState,
  }),
  Schema.Struct({
    ...TeachingRecordingManifestBase,
    cleanup: Schema.TaggedStruct("completed", {
      completedAt: nonEmptyString,
    }),
    lifecycle: Verified,
  }),
]);
export type TeachingRecordingManifest = typeof TeachingRecordingManifest.Type;

// ---------------------------------------------------------------------------
// Teaching event stream
// ---------------------------------------------------------------------------

/**
 * How one element was identified during Teaching, in terms that outlive the
 * recording. A short-lived element reference is useless to an agent reading
 * the stream later, so the target carries the accessibility role, the
 * accessible name, the nearby context that disambiguates a repeated name, and
 * the state the control was in when the user reached it.
 */
export const TeachingEventTarget = Schema.Struct({
  checked: Schema.NullOr(Schema.Boolean),
  /** Accessible names of the enclosing landmarks and groups, outermost first. */
  context: Schema.Array(Schema.String),
  disabled: Schema.NullOr(Schema.Boolean),
  name: Schema.String,
  role: nonEmptyString,
  /** Absent when the field was private, so no secret enters the stream. */
  value: Schema.NullOr(Schema.String),
  valueWithheld: Schema.NullOr(Schema.Boolean),
});
export type TeachingEventTarget = typeof TeachingEventTarget.Type;

/** A compact role-and-name summary of one element the Page gained or lost. */
export const TeachingTargetSummary = Schema.Struct({
  name: Schema.String,
  role: nonEmptyString,
});
export type TeachingTargetSummary = typeof TeachingTargetSummary.Type;

/** What the Page looked like at one instant, bounded to what a reader needs. */
export const TeachingObservation = Schema.Struct({
  nodeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: Schema.String,
  url: Schema.String,
});
export type TeachingObservation = typeof TeachingObservation.Type;

const teachingEventBase = {
  at: nonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

const TeachingStartedEvent = Schema.TaggedStruct("started", {
  ...teachingEventBase,
  emulation: DraftEmulation,
  url: Schema.String,
});

/**
 * One semantic action the user performed, with the observation on each side of
 * it. `appeared` and `disappeared` name what the action changed, which is the
 * evidence a learning agent needs to write a completion condition.
 */
const TeachingActionEvent = Schema.TaggedStruct("action", {
  ...teachingEventBase,
  after: TeachingObservation,
  appeared: Schema.Array(TeachingTargetSummary),
  before: TeachingObservation,
  description: nonEmptyString,
  detail: Schema.NullOr(Schema.String),
  disappeared: Schema.Array(TeachingTargetSummary),
  id: nonEmptyString,
  kind: nonEmptyString,
  outcome: Schema.Literals(["succeeded", "failed"]),
  target: Schema.NullOr(TeachingEventTarget),
});

/** A top-level navigation, whether the user caused it or the Page did. */
const TeachingUrlEvent = Schema.TaggedStruct("url", {
  ...teachingEventBase,
  from: Schema.String,
  url: Schema.String,
});

/** Free text the user relayed while demonstrating. */
const TeachingInstructionEvent = Schema.TaggedStruct("instruction", {
  ...teachingEventBase,
  text: nonEmptyString,
});

/** A masked visual observation, stored once under its content address. */
const TeachingKeyframeEvent = Schema.TaggedStruct("keyframe", {
  ...teachingEventBase,
  actionId: Schema.NullOr(Schema.String),
  hash: EvidenceHash,
  /** Relative to the recording directory. */
  path: nonEmptyString,
});

/** Why capture ended. A limit or an encoder failure is visible to the reader. */
export const TeachingStopReason = Schema.Literals([
  "user",
  "session-closed",
  "limit-reached",
  "capture-failed",
]);
export type TeachingStopReason = typeof TeachingStopReason.Type;

const TeachingStoppedEvent = Schema.TaggedStruct("stopped", {
  ...teachingEventBase,
  detail: Schema.NullOr(Schema.String),
  reason: TeachingStopReason,
});

/**
 * One line of `events.jsonl`. The stream is append-only and written only while
 * Teaching is in `recording`, so setup activity cannot reach it.
 */
export const TeachingEvent = Schema.Union([
  TeachingStartedEvent,
  TeachingActionEvent,
  TeachingUrlEvent,
  TeachingInstructionEvent,
  TeachingKeyframeEvent,
  TeachingStoppedEvent,
]);
export type TeachingEvent = typeof TeachingEvent.Type;

/**
 * The size ceilings one recording may reach. Reaching any of them stops the
 * recording and reports a visible failure rather than silently truncating the
 * evidence a learning agent is about to trust.
 */
export const TeachingCaptureLimits = Schema.Struct({
  durationMs: Schema.Int.check(Schema.isGreaterThan(0)),
  eventBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  events: Schema.Int.check(Schema.isGreaterThan(1)),
  keyframes: Schema.Int.check(Schema.isGreaterThan(0)),
  videoBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type TeachingCaptureLimits = typeof TeachingCaptureLimits.Type;
