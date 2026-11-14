import { Schema } from "effect";

import { AgentExecutionBoundary } from "./agent-browser.ts";
import { AgentPendingDecision } from "./agent-decision.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { FlowName } from "./flow-identifiers.ts";
import {
  AndroidPreparation,
  AndroidStartingConditions,
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
).annotate({ identifier: "Text" });

/** The API levels in the Android Support Matrix. Selection refuses every other level. */
export const androidSupportedApi = { maximum: 36, minimum: 30 } as const;
export const isAndroidSupportedApi = (api: number | null): api is number =>
  api !== null &&
  Number.isInteger(api) &&
  api >= androidSupportedApi.minimum &&
  api <= androidSupportedApi.maximum;
/** Permission flags that keep a denied choice from prompting again need API 31. */
export const androidPermissionDecisionApi = 31;

// Any positive level decodes, so the runtime refuses it with a typed reason.
const apiLevel = Schema.Int.check(Schema.isGreaterThan(0));

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceSelection = Schema.Struct({
  /** An uploaded `.apk` to install with consent: the session's temporary copy. */
  apkPath: Schema.optionalKey(Schema.NonEmptyString),
  device: Schema.Union([
    Schema.Struct({
      api: apiLevel,
      avd: text,
      fingerprint: text,
      host: Schema.Literal("local"),
      kind: Schema.optionalKey(Schema.Literal("emulator")),
      serial: text,
    }),
    Schema.Struct({
      api: apiLevel,
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
  helperConsent: Schema.Literals(["none", "install", "replace", "auto"]),
  outcomes: AndroidStartingConditions,
  privateInput: Schema.optionalKey(Schema.Boolean),
  setup: AndroidPreparation,
});
export type AndroidWorkspaceSelection = typeof AndroidWorkspaceSelection.Type;

/** Device-pixel rectangle in the containing observation's display coordinate space. */
// oxlint-disable-next-line eslint/no-redeclare
export const AndroidElementBounds = Schema.Struct({
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  x: Schema.Finite,
  y: Schema.Finite,
});
export type AndroidElementBounds = typeof AndroidElementBounds.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidDiscoveredDevice = Schema.Struct({
  api: Schema.NullOr(apiLevel),
  avd: Schema.NullOr(text),
  fingerprint: Schema.NullOr(text),
  kind: Schema.Literals(["emulator", "physical"]),
  model: Schema.NullOr(text),
  release: Schema.NullOr(text),
  serial: text,
  state: Schema.Literals([
    "device",
    "offline",
    "unauthorized",
    "unavailable",
    "stopped",
  ]),
});
export type AndroidDiscoveredDevice = typeof AndroidDiscoveredDevice.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidDiscoveredApp = Schema.Struct({
  label: Schema.String,
  launchActivity: text,
  package: text,
  versionCode: text,
  versionName: Schema.String,
});
export type AndroidDiscoveredApp = typeof AndroidDiscoveredApp.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceObservation = Schema.Struct({
  capturedAt: text,
  height: Schema.Number,
  id: text,
  image: Schema.NullOr(Schema.String),
  nodes: Schema.Array(
    Schema.Struct({
      bounds: Schema.optionalKey(AndroidElementBounds),
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
      /** For an app installation: the build it replaces, or null when absent. */
      installedBuild: Schema.optionalKey(Schema.NullOr(text)),
      kind: Schema.Literals([
        "run-environment-permission",
        "app-installation",
        "clear-app-data",
        "confirmation",
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
  flowName: FlowName,
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
  boundary: Schema.optionalKey(Schema.NullOr(AgentExecutionBoundary)),
  captureState: Schema.NullOr(TeachingCaptureState),
  cleanup: Schema.NullOr(TeachingRecordingCleanupState),
  field: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      observationId: text,
      password: Schema.optionalKey(Schema.Boolean),
      role: Schema.String,
      target: text,
    })
  ),
  observation: Schema.NullOr(AndroidWorkspaceObservation),
  pendingDecision: Schema.optionalKey(Schema.NullOr(AgentPendingDecision)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: text,
        purpose: Schema.String,
        requestId: text,
        setup: Schema.Boolean,
        status: Schema.Literals(["requested", "supplied", "refused"]),
      })
    )
  ),
});
export type AndroidWorkspaceSnapshot = typeof AndroidWorkspaceSnapshot.Type;

const fraction = Schema.Finite.check(
  Schema.isBetween({ maximum: 1, minimum: 0 })
);
/** When the Workspace saw the input, in its own milliseconds. Orders and times gestures only. */
const inputTime = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One piece of Forwarded Input: what the user did on a native Workspace
 * canvas, sent straight to the device rather than resolved to a semantic
 * target first. Points are fractions of the displayed screen.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const NativeInput = Schema.Union([
  Schema.TaggedStruct("touch", {
    action: Schema.Literals(["down", "move", "up"]),
    at: inputTime,
    x: fraction,
    y: fraction,
  }),
  Schema.TaggedStruct("scroll", {
    at: inputTime,
    deltaX: Schema.Finite.check(
      Schema.isBetween({ maximum: 10_000, minimum: -10_000 })
    ),
    deltaY: Schema.Finite.check(
      Schema.isBetween({ maximum: 10_000, minimum: -10_000 })
    ),
    x: fraction,
    y: fraction,
  }),
  Schema.TaggedStruct("key", {
    action: Schema.Literals(["down", "up"]),
    at: inputTime,
    /** The physical key, as `KeyboardEvent.code` names it. */
    code: Schema.String.check(Schema.isMaxLength(32)),
    /** The key's meaning, as `KeyboardEvent.key` names it. */
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    /** Alt 1, Control 2, Meta 4, Shift 8. */
    modifiers: Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 0 })),
  }),
]);
export type NativeInput = typeof NativeInput.Type;

const deviceSessionId = AgentSessionId.annotate({ identifier: "Id" });
const deviceOperationId = OperationId.annotate({ identifier: "Op" });
const session = { sessionId: deviceSessionId };
const mutation = { ...session, operationId: deviceOperationId };

/**
 * Workspace-only Forwarded Input for a native session, on Android and iOS.
 * It has its own RPC that answers once the input is written to the device,
 * so input never waits on a snapshot. MCP never exposes it.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const NativeForward = Schema.Struct({
  ...session,
  inputs: Schema.NonEmptyArray(NativeInput).check(Schema.isMaxLength(256)),
});
export type NativeForward = typeof NativeForward.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidWorkspaceCommand = Schema.Union([
  Schema.TaggedStruct("start", {
    agentSetup: Schema.optionalKey(Schema.Boolean),
    flowName: FlowName,
    group: Schema.optionalKey(Schema.String),
    kind: Schema.Literals(["teaching", "dry-run", "run"]),
    operationId: deviceOperationId,
    /** Workspace confirmation authorizes this exact selection and immediate preparation. */
    prepareAndOpen: Schema.optionalKey(Schema.Boolean),
    recordingId: Schema.NullOr(TeachingRecordingId),
    selection: AndroidWorkspaceSelection,
  }),
  Schema.TaggedStruct("variable-request", {
    ...mutation,
    name: Schema.String.check(
      Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
      Schema.isMaxLength(128)
    ),
    purpose: text,
    replace: Schema.Boolean,
  }),
  // Workspace-only. Never exposed in the MCP tool's parameter schema.
  Schema.TaggedStruct("variable-supply", {
    ...mutation,
    name: Schema.String.check(
      Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
      Schema.isMaxLength(128)
    ),
    requestId: text,
    value: Schema.NullOr(text),
  }),
  Schema.TaggedStruct("setup-handoff", mutation),
  Schema.TaggedStruct("field-dismiss", mutation),
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
      Schema.TaggedStruct("variable", {
        name: Schema.String.check(
          Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
          Schema.isMaxLength(128)
        ),
        target: text,
      }),
      Schema.TaggedStruct("back", {}),
    ]),
    irreversible: Schema.optionalKey(Schema.Boolean),
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

// oxlint-disable-next-line eslint/no-redeclare
export const AndroidStreamPacket = Schema.Union([
  Schema.TaggedStruct("frame", {
    data: Schema.String.check(Schema.isMaxLength(3 * 1024 * 1024)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    key: Schema.Boolean,
    timestamp: Schema.Finite,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct("state", {
    state: Schema.Literals(["connecting", "secure", "lost"]),
  }),
]);
export type AndroidStreamPacket = typeof AndroidStreamPacket.Type;
