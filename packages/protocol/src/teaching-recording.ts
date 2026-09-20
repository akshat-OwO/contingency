import { Effect, Schema } from "effect";

import {
  AgentActionOutcome,
  AgentBrowserAction,
  AgentElementRef,
  AgentSnapshotId,
} from "./agent-browser.ts";
import {
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { DraftEmulation, Variable } from "./emulation.ts";
import { optionalNullable } from "./optional-field.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Variable names are shouty snake case, so `{{NAME}}` is unambiguous. */
const variableName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
  Schema.isMinLength(1)
);

/** The content address of one captured artifact's bytes. */
export const ContentHash = Schema.String.check(
  Schema.isPattern(/^sha256-[a-f0-9]{64}$/u)
).pipe(Schema.brand("@contingency/ContentHash"));
export type ContentHash = typeof ContentHash.Type;

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
/**
 * The exclusive hold one learning process has on a Teaching Recording. It
 * outlives a single save: the claim rides the drafted, dry-running, failed,
 * and passed states so the agent that learned the flow can fix its package and
 * save again without claiming the recording a second time.
 */
export const TeachingLearningClaim = Schema.Struct({
  claimedAt: nonEmptyString,
  operationId: OperationId,
  ownerPid: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type TeachingLearningClaim = typeof TeachingLearningClaim.Type;

const Learning = Schema.TaggedStruct("learning", {
  claim: TeachingLearningClaim,
  readyAt: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const SkillDrafted = Schema.TaggedStruct("skill-drafted", {
  claim: Schema.optional(TeachingLearningClaim),
  draftedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const DryRunning = Schema.TaggedStruct("dry-running", {
  claim: Schema.optional(TeachingLearningClaim),
  draftedAt: nonEmptyString,
  dryRunInputs: Schema.Array(
    Schema.Struct({
      changed: Schema.Boolean,
      name: nonEmptyString,
      value: Schema.NullOr(Schema.String),
    })
  ),
  dryRunSessionId: AgentSessionId,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
export const FlowSkillDryRunResult = Schema.Struct({
  completedAt: nonEmptyString,
  inputs: Schema.Array(
    Schema.Struct({
      changed: Schema.Boolean,
      name: nonEmptyString,
      value: Schema.NullOr(Schema.String),
    })
  ),
  observableOutcome: nonEmptyString,
  outcome: Schema.Literals(["failed", "passed"]),
});
export type FlowSkillDryRunResult = typeof FlowSkillDryRunResult.Type;

const DryRunFailed = Schema.TaggedStruct("dry-run-failed", {
  claim: Schema.optional(TeachingLearningClaim),
  draftedAt: nonEmptyString,
  dryRunEndedAt: nonEmptyString,
  dryRunResult: FlowSkillDryRunResult,
  dryRunSessionId: AgentSessionId,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const DryRunPassed = Schema.TaggedStruct("dry-run-passed", {
  claim: Schema.optional(TeachingLearningClaim),
  draftedAt: nonEmptyString,
  dryRunEndedAt: nonEmptyString,
  dryRunResult: FlowSkillDryRunResult,
  dryRunSessionId: AgentSessionId,
  dryRunStartedAt: nonEmptyString,
  readyAt: nonEmptyString,
  skillPath: nonEmptyString,
  startedAt: nonEmptyString,
  stoppedAt: nonEmptyString,
});
const Verified = Schema.TaggedStruct("verified", {
  draftedAt: nonEmptyString,
  dryRunEndedAt: nonEmptyString,
  dryRunResult: FlowSkillDryRunResult,
  dryRunSessionId: AgentSessionId,
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
  readyAt: Schema.optional(nonEmptyString),
  startedAt: Schema.optional(nonEmptyString),
  stoppedAt: Schema.optional(nonEmptyString),
});

export const TeachingCaptureState = Schema.Union([
  Setup,
  Recording,
  Finalizing,
  Ready,
  Learning,
  SkillDrafted,
  DryRunning,
  DryRunFailed,
  DryRunPassed,
  Verified,
  Failed,
]);
export type TeachingCaptureState = typeof TeachingCaptureState.Type;

export const TeachingRecordingArtifact = Schema.Struct({
  capturedAt: nonEmptyString,
  hash: ContentHash,
  id: nonEmptyString,
  kind: Schema.Literals(["events", "keyframe", "screenshot", "trace", "video"]),
  path: nonEmptyString,
});
export type TeachingRecordingArtifact = typeof TeachingRecordingArtifact.Type;

export const TeachingRecordingCleanupState = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("purge-pending", {
    failure: Schema.NullOr(Schema.String),
    retainedFiles: Schema.Array(nonEmptyString),
  }),
  Schema.TaggedStruct("purged", { completedAt: nonEmptyString }),
]);
export type TeachingRecordingCleanupState =
  typeof TeachingRecordingCleanupState.Type;

export const TeachingRecordingOperation = Schema.Literals([
  "begin",
  "start",
  "stop",
  "start-learning",
  "release-learning",
  "fail-learning",
  "save-skill",
  "start-dry-run",
  "fail-dry-run",
  "pass-dry-run",
  "reject",
  "cleanup",
  "verification",
  "rename",
  "discard",
]);
export type TeachingRecordingOperation = typeof TeachingRecordingOperation.Type;

export const TeachingRecordingReceipt = Schema.Struct({
  completedAt: nonEmptyString,
  files: Schema.optional(Schema.Array(nonEmptyString)),
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
    cleanup: Schema.TaggedStruct("purge-pending", {
      failure: Schema.NullOr(Schema.String),
      retainedFiles: Schema.Array(nonEmptyString),
    }),
    lifecycle: Verified,
  }),
  Schema.Struct({
    ...TeachingRecordingManifestBase,
    cleanup: Schema.TaggedStruct("purged", {
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
  /** The element the instruction was attached to, when it named one. */
  target: Schema.NullOr(nonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  text: nonEmptyString,
});

/** A masked visual observation, stored once under its content address. */
const TeachingKeyframeEvent = Schema.TaggedStruct("keyframe", {
  ...teachingEventBase,
  actionId: Schema.NullOr(Schema.String),
  hash: ContentHash,
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

// ---------------------------------------------------------------------------
// Learning-agent projection
// ---------------------------------------------------------------------------

/**
 * The largest JSON timeline page returned through MCP. A page that cannot fit
 * one event is refused; a longer recording is split across explicit cursors.
 */
export const TEACHING_TIMELINE_BUDGET_CHARACTERS = 64 * 1024;
export const TEACHING_TIMELINE_MAX_EVENTS = 100;
export const TEACHING_RECORDING_WAIT_MAX_MS = 60_000;

export const TeachingRecordingSummary = Schema.Struct({
  cleanup: TeachingRecordingCleanupState,
  failure: Schema.NullOr(Schema.String),
  flowSkillName: FlowSkillName,
  lifecycle: Schema.Literals([
    "recording",
    "ready",
    "learning",
    "skill-drafted",
    "dry-running",
    "dry-run-failed",
    "dry-run-passed",
    "verified",
    "failed",
  ]),
  recordingId: TeachingRecordingId,
  updatedAt: nonEmptyString,
});
export type TeachingRecordingSummary = typeof TeachingRecordingSummary.Type;

export const TeachingRecordingList = Schema.Struct({
  recordings: Schema.Array(TeachingRecordingSummary),
});
export type TeachingRecordingList = typeof TeachingRecordingList.Type;

export const TeachingRecordingClaim = Schema.Struct({
  claimedAt: nonEmptyString,
  flowSkillName: FlowSkillName,
  operationId: OperationId,
  recordingId: TeachingRecordingId,
});
export type TeachingRecordingClaim = typeof TeachingRecordingClaim.Type;

/**
 * What one claim transition answers with. Taking a claim carries the claim
 * itself; releasing or failing one carries `null` beside the recording's new
 * durable state, so a single tool reports all three without a union the caller
 * has to narrow.
 */
export const TeachingRecordingClaimResult = Schema.Struct({
  claim: Schema.NullOr(TeachingRecordingClaim),
  recording: TeachingRecordingSummary,
});
export type TeachingRecordingClaimResult =
  typeof TeachingRecordingClaimResult.Type;

export const TeachingTimelineKeyframe = Schema.TaggedStruct("keyframe", {
  actionId: Schema.NullOr(Schema.String),
  at: nonEmptyString,
  hash: ContentHash,
  id: nonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const TeachingTimelineEntry = Schema.Union([
  TeachingStartedEvent,
  TeachingActionEvent,
  TeachingUrlEvent,
  TeachingInstructionEvent,
  TeachingTimelineKeyframe,
  TeachingStoppedEvent,
]);
export type TeachingTimelineEntry = typeof TeachingTimelineEntry.Type;

export const TeachingTimeline = Schema.Struct({
  entries: Schema.Array(TeachingTimelineEntry),
  maxCharacters: Schema.Literal(TEACHING_TIMELINE_BUDGET_CHARACTERS),
  nextCursor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  recordingId: TeachingRecordingId,
});
export type TeachingTimeline = typeof TeachingTimeline.Type;

export const TeachingKeyframeContent = Schema.Struct({
  format: Schema.Literal("png"),
  hash: ContentHash,
  id: nonEmptyString,
  image: nonEmptyString,
  recordingId: TeachingRecordingId,
});
export type TeachingKeyframeContent = typeof TeachingKeyframeContent.Type;

export const FlowSkillFile = Schema.Struct({
  content: nonEmptyString,
  path: nonEmptyString,
});
export type FlowSkillFile = typeof FlowSkillFile.Type;

/**
 * One structured reason a proposed Flow Skill package was refused. The path
 * starts at the file it belongs to, so an agent can fix the exact line rather
 * than resubmit the whole package. It is not a JSON pointer: a Flow Skill is
 * markdown, not a draft object.
 */
export const FlowSkillDiagnostic = Schema.Struct({
  code: nonEmptyString,
  message: nonEmptyString,
  /** File first, then the section or field inside it. */
  path: Schema.Array(nonEmptyString),
});
export type FlowSkillDiagnostic = typeof FlowSkillDiagnostic.Type;

export const FlowSkillSaveResult = Schema.Struct({
  files: Schema.Array(nonEmptyString),
  flowSkillName: FlowSkillName,
  recordingId: TeachingRecordingId,
});
export type FlowSkillSaveResult = typeof FlowSkillSaveResult.Type;

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

// ---------------------------------------------------------------------------
// In-process capture record
// ---------------------------------------------------------------------------

/**
 * The content address of one captured keyframe's bytes. Keyframes live only in
 * the owning process and in the recording directory; they never enter a Flow
 * Skill package (ADR 0039).
 */
export const KeyframeHash = Schema.String.check(
  Schema.isPattern(/^sha256-[a-f0-9]{64}$/u)
).pipe(Schema.brand("@contingency/KeyframeHash"));
export type KeyframeHash = typeof KeyframeHash.Type;

/** Redacted, bounded observation of one user input event during Takeover. */
export const CapturedUserInput = Schema.Struct({
  eventType: Schema.Literals([
    "char",
    "keyDown",
    "keyUp",
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
    "mouseWheel",
  ]),
  inputType: Schema.Literals(["keyboard", "mouse"]),
  key: optionalNullable(Schema.Literal("[user input]")),
  text: optionalNullable(Schema.Literal("[user input]")),
});
export type CapturedUserInput = typeof CapturedUserInput.Type;

/**
 * One browser action captured while recording, with who performed it and the
 * Page it left behind. Snapshot ids point into the capture record's snapshot
 * table so hundreds of actions do not repeat one document's accessibility
 * tree.
 */
export const CapturedAction = Schema.Struct({
  /** Agent actions, or a low-level input event captured during Takeover. */
  action: Schema.Union([
    AgentBrowserAction,
    Schema.Struct({
      input: CapturedUserInput,
      type: Schema.Literal("input"),
    }),
  ]),
  actor: AgentSessionController,
  at: nonEmptyString,
  description: nonEmptyString,
  detail: optionalNullable(Schema.String),
  id: nonEmptyString,
  outcome: AgentActionOutcome,
  snapshotAfter: Schema.NullOr(AgentSnapshotId),
  snapshotBefore: Schema.NullOr(AgentSnapshotId),
  urlAfter: Schema.String,
  urlBefore: Schema.String,
});
export type CapturedAction = typeof CapturedAction.Type;

/**
 * A reference to one best-effort-masked keyframe. The bytes are stored once
 * under their content address and fetched on demand, so the capture record
 * stays bounded by how much the user demonstrated rather than by how large
 * the Page's pixels are.
 */
export const TeachingKeyframe = Schema.Struct({
  /** The captured action this keyframe photographed the result of, if any. */
  actionId: Schema.NullOr(Schema.String),
  capturedAt: nonEmptyString,
  contentHash: KeyframeHash,
  format: Schema.Literal("png"),
  id: nonEmptyString,
  url: Schema.String,
});
export type TeachingKeyframe = typeof TeachingKeyframe.Type;

/** One keyframe's bytes, fetched by reference, one keyframe at a time. */
export const TeachingKeyframeBytes = Schema.Struct({
  ...TeachingKeyframe.fields,
  encoding: Schema.Literal("base64"),
  image: nonEmptyString,
});
export type TeachingKeyframeBytes = typeof TeachingKeyframeBytes.Type;

/** What the user told the agent to do, as the agent relayed it. */
export const TeachingInstruction = Schema.Struct({
  at: nonEmptyString,
  id: nonEmptyString,
  /**
   * The element the instruction was attached to, by role and accessible name,
   * when it was attached to one. An instruction relayed over MCP names no
   * element and carries `null`.
   */
  target: Schema.NullOr(nonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  text: nonEmptyString,
});
export type TeachingInstruction = typeof TeachingInstruction.Type;

/** One observed change of the Page's URL, attributed to an action when known. */
export const UrlTransition = Schema.Struct({
  actionId: Schema.NullOr(nonEmptyString),
  at: nonEmptyString,
  from: Schema.String,
  to: Schema.String,
});
export type UrlTransition = typeof UrlTransition.Type;

export const TeachingInstructionRecord = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
  text: nonEmptyString,
});
export type TeachingInstructionRecord = typeof TeachingInstructionRecord.Type;

/**
 * Enter one private value while recording. The value exists only for this
 * browser action. Captured evidence stores `{{name}}` and the declaration.
 */
export const TeachingVariableInput = Schema.Struct({
  operationId: OperationId,
  /** Omit only in the Workspace, where the currently focused control is used. */
  ref: optionalNullable(AgentElementRef),
  sessionId: AgentSessionId,
  value: nonEmptyString,
  variable: Schema.Struct({
    name: variableName,
    runtime: Variable.fields.runtime,
    secret: Variable.fields.secret,
  }),
});
export type TeachingVariableInput = typeof TeachingVariableInput.Type;

/** What a Teaching session has captured so far, for the Workspace. */
export const TeachingProgress = Schema.Struct({
  actionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  instructionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The instructions themselves, oldest first, so the Workspace can read back
   * what was said without paging the timeline (#213). Both an inspect comment
   * and an instruction relayed over MCP appear here.
   */
  instructions: Schema.Array(TeachingInstruction).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
});
export type TeachingProgress = typeof TeachingProgress.Type;
