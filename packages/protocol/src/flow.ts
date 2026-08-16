import { Schema } from "effect";

import { BrowserTabId, SessionId } from "./browser-identifiers.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const Selector = Schema.Array(
  Schema.Union([nonEmptyString, Schema.Array(nonEmptyString)])
).check(Schema.isMinLength(1));
export type Selector = typeof Selector.Type;

export const AssertedNavigation = Schema.Struct({
  title: Schema.optional(Schema.String),
  type: Schema.Literal("navigation"),
  url: nonEmptyString,
});
export type AssertedNavigation = typeof AssertedNavigation.Type;

const selectorTargetFields = {
  assertedEvents: Schema.optional(Schema.Array(AssertedNavigation)),
  frame: Schema.optional(Schema.Array(Schema.Int)),
  selectors: Selector,
  target: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
};

export const NavigateStep = Schema.Struct({
  assertedEvents: Schema.optional(Schema.Array(AssertedNavigation)),
  timeout: Schema.optional(Schema.Finite),
  type: Schema.Literal("navigate"),
  url: nonEmptyString,
});
export type NavigateStep = typeof NavigateStep.Type;

export const ClickStep = Schema.Struct({
  ...selectorTargetFields,
  button: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Finite),
  offsetX: Schema.Finite,
  offsetY: Schema.Finite,
  type: Schema.Literal("click"),
});
export type ClickStep = typeof ClickStep.Type;

export const ChangeStep = Schema.Struct({
  ...selectorTargetFields,
  type: Schema.Literal("change"),
  value: Schema.String,
});
export type ChangeStep = typeof ChangeStep.Type;

export const KeyStep = Schema.Struct({
  ...selectorTargetFields,
  key: nonEmptyString,
  type: Schema.Literals(["keyDown", "keyUp"]),
});
export type KeyStep = typeof KeyStep.Type;

export const ChromeStep = Schema.Union([
  NavigateStep,
  ClickStep,
  ChangeStep,
  KeyStep,
]);
export type ChromeStep = typeof ChromeStep.Type;

export const AuditKind = Schema.Literals(["accessibility", "performance"]);
export type AuditKind = typeof AuditKind.Type;

export const AuditStep = Schema.Struct({
  name: Schema.Literal("contingency.audit"),
  parameters: Schema.Struct({ kind: AuditKind }),
  type: Schema.Literal("customStep"),
});
export type AuditStep = typeof AuditStep.Type;

export const PreStep = Schema.Struct({
  id: nonEmptyString,
  step: Schema.Union([ClickStep, ChangeStep, KeyStep]),
  when: Schema.Struct({
    selectors: Selector,
    type: Schema.Literal("selectorVisible"),
  }),
});
export type PreStep = typeof PreStep.Type;

/**
 * A named value a Flow declares but does not contain. `secret` redacts the
 * value from a persisted Run; `runtime` lets the Runner prompt for it when no
 * value was supplied and the terminal is interactive. The two are independent:
 * a 2FA code is both, a target environment URL is neither.
 */
export const Variable = Schema.Struct({
  name: nonEmptyString,
  runtime: Schema.Boolean,
  secret: Schema.Boolean,
});
export type Variable = typeof Variable.Type;

const StepExtension = Schema.Struct({
  id: nonEmptyString,
  preSteps: Schema.optional(Schema.Array(PreStep)),
  variable: Schema.optional(nonEmptyString),
});

const extendStep = <S extends Schema.Struct.Fields>(fields: S) =>
  Schema.Struct({
    ...fields,
    contingency: Schema.optional(StepExtension),
  });

export const FlowStep = Schema.Union([
  extendStep(NavigateStep.fields),
  extendStep(ClickStep.fields),
  extendStep(ChangeStep.fields),
  extendStep(KeyStep.fields),
  AuditStep,
]);
export type FlowStep = typeof FlowStep.Type;

export const Flow = Schema.Struct({
  contingency: Schema.optional(
    Schema.Struct({
      preSteps: Schema.optional(Schema.Array(PreStep)),
      variables: Schema.optional(Schema.Array(Variable)),
    })
  ),
  selectorAttribute: Schema.optional(Schema.String),
  steps: Schema.Array(FlowStep).check(Schema.isMinLength(1)),
  timeout: Schema.optional(Schema.Finite),
  title: nonEmptyString,
});
export type Flow = typeof Flow.Type;

export const RecordingPhase = Schema.Literals([
  "active",
  "paused",
  "incomplete",
  "finished",
]);
export type RecordingPhase = typeof RecordingPhase.Type;

export const RecordingCaptureMode = Schema.Literals([
  "ordinary",
  "flowPreStep",
  "stepPreStep",
  "conditionPicker",
]);
export type RecordingCaptureMode = typeof RecordingCaptureMode.Type;

export const RecordedStep = Schema.Struct({
  id: nonEmptyString,
  preSteps: Schema.Array(PreStep),
  step: Schema.Union([ChromeStep, AuditStep]),
  variable: Schema.optional(nonEmptyString),
});
export type RecordedStep = typeof RecordedStep.Type;

export const hasAuthoredBrowserStep = (
  recordedSteps: readonly RecordedStep[]
): boolean =>
  recordedSteps.some(
    ({ step }, index) => index > 0 && step.type !== "customStep"
  );

export const RecordingSnapshot = Schema.Struct({
  captureMode: RecordingCaptureMode,
  downloadName: Schema.optional(Schema.String),
  flow: Flow,
  incompleteReason: Schema.optional(Schema.String),
  initialUrl: nonEmptyString,
  phase: RecordingPhase,
  recordedSteps: Schema.Array(RecordedStep),
  revision: Schema.Int,
  sessionId: SessionId,
  tabId: BrowserTabId,
  targetStepId: Schema.optional(Schema.String),
  undoAvailable: Schema.Boolean,
});
export type RecordingSnapshot = typeof RecordingSnapshot.Type;

export const recordingMakesBrowserInputReadOnly = (
  recording: Pick<RecordingSnapshot, "captureMode" | "phase"> | null
): boolean =>
  recording?.phase === "incomplete" ||
  (recording?.phase === "paused" && recording.captureMode === "ordinary");

export const recordingLocksStorageMutations = (
  recording: Pick<RecordingSnapshot, "phase" | "sessionId"> | null,
  sessionId: string
): boolean =>
  recording !== null &&
  recording.sessionId === sessionId &&
  recording.phase !== "finished";
