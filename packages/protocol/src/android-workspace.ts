import { Schema } from "effect";

import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { FlowSkillName } from "./flow-skill-identifiers.ts";
import {
  AndroidPreparation,
  AndroidStartingCondition,
  PlatformRequirements,
} from "./platform.ts";
import { TeachingRecordingId } from "./teaching-recording-identifiers.ts";
import {
  TeachingCaptureState,
  TeachingRecordingCleanupState,
} from "./teaching-recording.ts";

const text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096)
);

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceSelection = Schema.Struct({
  device: Schema.Union([
    Schema.Struct({
      api: Schema.Literal(36),
      avd: text,
      fingerprint: text,
      host: Schema.Literal("local"),
      kind: Schema.optionalKey(Schema.Literal("emulator")),
      serial: text,
    }),
    Schema.Struct({
      api: Schema.Literal(36),
      fingerprint: text,
      host: Schema.Literal("local"),
      kind: Schema.Literal("physical"),
      model: text,
      serial: text,
    }),
  ]),
  environment: Schema.Struct({
    androidVersion: text,
    appBuild: text,
    appId: text,
    permissions:
      PlatformRequirements.members[1].fields.environment.fields.permissions,
    startingState: text,
  }),
  helperConsent: Schema.Literals(["none", "install", "replace"]),
  outcomes: Schema.Array(AndroidStartingCondition).check(Schema.isMinLength(1)),
  reversibleActions: Schema.Array(AndroidStartingCondition),
  setup: AndroidPreparation,
});
export type AndroidWorkspaceSelection = typeof AndroidWorkspaceSelection.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceObservation = Schema.Struct({
  capturedAt: text,
  height: Schema.Number,
  id: text,
  image: Schema.NullOr(Schema.String),
  nodes: Schema.Array(
    Schema.Struct({
      covered: Schema.Boolean,
      editable: Schema.Boolean,
      name: Schema.String,
      password: Schema.Boolean,
      role: Schema.String,
      target: text,
    })
  ),
  width: Schema.Number,
});
export type AndroidWorkspaceObservation =
  typeof AndroidWorkspaceObservation.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspacePreparation = Schema.Struct({
  differences: Schema.Array(
    Schema.Struct({
      field: text,
      selected: Schema.String,
      taught: Schema.String,
    })
  ),
  evidence: Schema.Array(
    Schema.Struct({
      code: Schema.optionalKey(text),
      decisionId: Schema.optionalKey(text),
      observationId: Schema.optionalKey(text),
      type: text,
    })
  ),
  pending: Schema.Array(
    Schema.Struct({
      id: text,
      kind: Schema.Literals([
        "run-environment-permission",
        "app-installation",
        "clear-app-data",
      ]),
      serial: Schema.optionalKey(text),
      targetApp: text,
    })
  ),
  phase: Schema.Literals(["pending", "ready", "paused", "refused", "closed"]),
});

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceSummary = Schema.Struct({
  assessment: Schema.NullOr(
    Schema.Struct({
      explanation: text,
      observationId: text,
      outcome: Schema.Literals([
        "working",
        "not-working",
        "inconclusive",
        "blocked",
      ]),
    })
  ),
  captureGaps: Schema.Array(text),
  completedAt: Schema.NullOr(text),
  controller: Schema.Literals(["agent", "user"]),
  error: Schema.NullOr(text),
  experimental: Schema.Literal(true),
  flowSkillName: FlowSkillName,
  id: AgentSessionId,
  kind: Schema.Literals(["teaching", "dry-run", "run"]),
  phase: Schema.Literals([
    "pending",
    "running",
    "paused",
    "completed",
    "closed",
    "refused",
  ]),
  preparation: AndroidWorkspacePreparation,
  recordingId: Schema.NullOr(TeachingRecordingId),
  requirements: PlatformRequirements,
  selection: AndroidWorkspaceSelection,
  startedAt: text,
  takeoverOccurred: Schema.Boolean,
});
export type AndroidWorkspaceSummary = typeof AndroidWorkspaceSummary.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceSnapshot = Schema.Struct({
  ...AndroidWorkspaceSummary.fields,
  captureState: Schema.NullOr(TeachingCaptureState),
  cleanup: Schema.NullOr(TeachingRecordingCleanupState),
  observation: Schema.NullOr(AndroidWorkspaceObservation),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AndroidWorkspaceSnapshot = typeof AndroidWorkspaceSnapshot.Type;

const session = { sessionId: AgentSessionId };
const mutation = { ...session, operationId: OperationId };

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceCommand = Schema.Union([
  Schema.TaggedStruct("start", {
    flowSkillName: FlowSkillName,
    kind: Schema.Literals(["teaching", "dry-run", "run"]),
    operationId: OperationId,
    recordingId: Schema.NullOr(TeachingRecordingId),
    selection: AndroidWorkspaceSelection,
  }),
  Schema.TaggedStruct("observe", { ...session, image: Schema.Boolean }),
  Schema.TaggedStruct("read", session),
  Schema.TaggedStruct("prepare", mutation),
  Schema.TaggedStruct("recover", mutation),
  Schema.TaggedStruct("decide", {
    ...mutation,
    allow: Schema.Boolean,
    decisionId: text,
  }),
  Schema.TaggedStruct("input", {
    ...mutation,
    action: Schema.Union([
      Schema.TaggedStruct("activate", { target: text }),
      Schema.TaggedStruct("fill", {
        target: text,
        text: Schema.String.check(Schema.isMaxLength(4096)),
      }),
      Schema.TaggedStruct("back", {}),
    ]),
    observationId: text,
  }),
  Schema.TaggedStruct("record", { ...mutation, start: Schema.Boolean }),
  Schema.TaggedStruct("instruction", { ...mutation, text }),
  Schema.TaggedStruct("control", {
    ...mutation,
    controller: Schema.Literals(["agent", "user"]),
  }),
  Schema.TaggedStruct("complete", {
    ...mutation,
    assessment: Schema.Struct({
      explanation: text,
      observationId: text,
      outcome: Schema.Literals([
        "working",
        "not-working",
        "inconclusive",
        "blocked",
      ]),
    }),
  }),
  Schema.TaggedStruct("close", mutation),
  Schema.TaggedStruct("flow-decision", {
    ...mutation,
    decision: Schema.Literals(["verify", "reject", "retry-cleanup"]),
  }),
]);
export type AndroidWorkspaceCommand = typeof AndroidWorkspaceCommand.Type;
