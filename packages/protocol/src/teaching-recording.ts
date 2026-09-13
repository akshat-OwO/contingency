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
