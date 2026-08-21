import { Schema, SchemaGetter } from "effect";

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

/**
 * Audit means accessibility only. Performance is not an Audit: it is a toggle
 * on a navigating Step, measured by the Runner at that navigation
 * ([ADR 0008](../../../docs/adr/0008-performance-is-a-navigation-step-toggle.md)).
 */
export const AuditKind = Schema.Literal("accessibility");
export type AuditKind = typeof AuditKind.Type;

/**
 * The rule tags an accessibility Audit runs, pinned rather than left at the
 * engine's default. An engine upgrade otherwise introduces new rules silently,
 * and on the day of the upgrade every one of them looks like a Regression.
 *
 * WCAG 2.0 through 2.2, levels A and AA: the conformance target nearly every
 * accessibility policy actually names. Best-practice rules are deliberately
 * excluded — they are opinions, and they move between engine releases.
 *
 * `wcag21a` is absent because the engine has no rules under it, verified
 * against the bundled binary: a tag selecting nothing is indistinguishable
 * from a misspelled one, and both audit every page clean.
 */
export const accessibilityRuleTags = [
  "wcag2a",
  "wcag2aa",
  "wcag21aa",
  "wcag22aa",
] as const;

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

/**
 * A Variable as Flows exported before the rename declared it: a bare name,
 * always secret, never anything else. Kept as a distinct schema so the
 * migration reads against exactly what old exports contained and nothing more.
 */
const LegacySecretVariable = Schema.Struct({ name: nonEmptyString });

/**
 * Fold pre-rename `secretVariables` into the current declaration list. A
 * legacy Variable was a credential the recorder never stored, so it migrates
 * as both `secret` (redact it from artifacts) and `runtime` (prompt for it at
 * Run time rather than failing preflight on a Flow that could never carry its
 * own value). Names already declared in the new format win, so a Flow edited
 * after the rename keeps its explicit choices.
 */
const withLegacySecretVariables = (
  variables: readonly Variable[] | undefined,
  legacy: readonly { readonly name: string }[] | undefined
): readonly Variable[] | undefined => {
  if (legacy === undefined || legacy.length === 0) {
    return variables;
  }
  const declared = new Set((variables ?? []).map(({ name }) => name));
  const migrated = legacy
    .filter(({ name }) => !declared.has(name))
    .map(({ name }) => ({ name, runtime: true, secret: true }));
  const merged = [...(variables ?? []), ...migrated];
  return merged.length === 0 ? undefined : merged;
};

const FlowContingency = Schema.Struct({
  /**
   * Stable identity for the Flow, independent of its user-editable title,
   * so Run history survives a rename. Optional, because a plain Chrome
   * DevTools Recorder export carries no Contingency fields (ADR 0001).
   */
  flowId: Schema.optional(nonEmptyString),
  preSteps: Schema.optional(Schema.Array(PreStep)),
  variables: Schema.optional(Schema.Array(Variable)),
  /** Capture Runs of this Flow to video. Not a {@link RecordingSnapshot}. */
  video: Schema.optional(Schema.Boolean),
});
type FlowContingency = typeof FlowContingency.Type;

/**
 * What a persisted Flow may literally contain: the current fields plus the
 * pre-rename spellings. Decoding migrates the old ones instead of dropping
 * them — a silent strip would turn an imported login Flow into one that types
 * nothing where its password goes.
 */
const FlowContingencyWithLegacyFields = Schema.Struct({
  ...FlowContingency.fields,
  secretVariables: Schema.optional(Schema.Array(LegacySecretVariable)),
});
type FlowContingencyWithLegacy = typeof FlowContingencyWithLegacyFields.Type;

const FlowContingencyWithLegacy = FlowContingencyWithLegacyFields.pipe(
  Schema.decodeTo(FlowContingency, {
    decode: SchemaGetter.transform(
      ({
        flowId,
        preSteps,
        secretVariables,
        variables,
        video,
      }: FlowContingencyWithLegacy): FlowContingency => {
        const merged = withLegacySecretVariables(variables, secretVariables);
        return {
          ...(flowId === undefined ? {} : { flowId }),
          ...(preSteps === undefined ? {} : { preSteps }),
          ...(merged === undefined ? {} : { variables: merged }),
          ...(video === undefined ? {} : { video }),
        };
      }
    ),
    encode: SchemaGetter.transform(
      (contingency: FlowContingency) => contingency
    ),
  })
);

/**
 * Where a decoded Variable binding comes from: the current spelling wins, and
 * the pre-rename `secretVariable` fills in only when no current one exists.
 */
const variableBinding = (
  variable: string | undefined,
  secretVariable: string | undefined
): { variable?: string } => {
  if (variable !== undefined) {
    return { variable };
  }
  if (secretVariable === undefined) {
    return {};
  }
  return { variable: secretVariable };
};

const StepExtensionFields = Schema.Struct({
  id: nonEmptyString,
  /**
   * Collect Core Web Vitals at this Step's navigation. Only meaningful on a
   * Step that navigates, and rejected by {@link Flow} anywhere else.
   */
  performance: Schema.optional(Schema.Boolean),
  preSteps: Schema.optional(Schema.Array(PreStep)),
  variable: Schema.optional(nonEmptyString),
});
type StepExtensionFields = typeof StepExtensionFields.Type;

/**
 * The Step extension as persisted Flows may spell it, including the pre-rename
 * `secretVariable` binding. Decoding renames it; where both spellings appear,
 * the current one wins.
 */
const StepExtensionWithLegacyFields = Schema.Struct({
  ...StepExtensionFields.fields,
  secretVariable: Schema.optional(nonEmptyString),
});
type StepExtensionWithLegacy = typeof StepExtensionWithLegacyFields.Type;

const StepExtension = StepExtensionWithLegacyFields.pipe(
  Schema.decodeTo(StepExtensionFields, {
    decode: SchemaGetter.transform(
      ({
        id,
        performance,
        preSteps,
        secretVariable,
        variable,
      }: StepExtensionWithLegacy): StepExtensionFields => ({
        ...variableBinding(variable, secretVariable),
        ...(performance === undefined ? {} : { performance }),
        ...(preSteps === undefined ? {} : { preSteps }),
        id,
      })
    ),
    encode: SchemaGetter.transform(
      (extension: StepExtensionFields) => extension
    ),
  })
);

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

/**
 * A Step navigates when it is a `navigate` Step, or a `click` Step carrying an
 * asserted navigation event. Only these can be measured for Core Web Vitals.
 */
export const stepNavigates = (step: FlowStep): boolean => {
  if (step.type === "navigate") {
    return true;
  }
  return (
    step.type === "click" &&
    (step.assertedEvents?.some(({ type }) => type === "navigation") ?? false)
  );
};

// `performance` on a Step that cannot navigate is malformed wherever it is
// read, so the schema rejects it rather than silently ignoring it (ADR 0008).
const performanceOnlyOnNavigatingSteps = Schema.makeFilter<readonly FlowStep[]>(
  (steps) =>
    steps.flatMap((step, index) => {
      if (
        step.type === "customStep" ||
        step.contingency?.performance !== true
      ) {
        return [];
      }
      if (stepNavigates(step)) {
        return [];
      }
      const label =
        step.contingency?.id === undefined
          ? `Step ${index + 1} (${step.type})`
          : `Step ${index + 1} (${step.type}, id ${step.contingency.id})`;
      return [
        {
          issue:
            `${label} cannot navigate, so it cannot measure performance. ` +
            "Set contingency.performance only on a navigate Step, or on a click Step with an asserted navigation event.",
          path: [index, "contingency", "performance"],
        },
      ];
    })
);

export const Flow = Schema.Struct({
  contingency: Schema.optional(FlowContingencyWithLegacy),
  selectorAttribute: Schema.optional(Schema.String),
  steps: Schema.Array(FlowStep).check(
    Schema.isMinLength(1),
    performanceOnlyOnNavigatingSteps
  ),
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

const RecordedStepFields = Schema.Struct({
  id: nonEmptyString,
  preSteps: Schema.Array(PreStep),
  step: Schema.Union([ChromeStep, AuditStep]),
  variable: Schema.optional(nonEmptyString),
});
type RecordedStepFields = typeof RecordedStepFields.Type;

const RecordedStepWithLegacyFields = Schema.Struct({
  ...RecordedStepFields.fields,
  secretVariable: Schema.optional(nonEmptyString),
});
type RecordedStepWithLegacy = typeof RecordedStepWithLegacyFields.Type;

/** {@link RecordedStep}, accepting the pre-rename `secretVariable` spelling. */
export const RecordedStep = RecordedStepWithLegacyFields.pipe(
  Schema.decodeTo(RecordedStepFields, {
    decode: SchemaGetter.transform(
      ({
        id,
        preSteps,
        secretVariable,
        step,
        variable,
      }: RecordedStepWithLegacy): RecordedStepFields => ({
        ...variableBinding(variable, secretVariable),
        id,
        preSteps,
        step,
      })
    ),
    encode: SchemaGetter.transform((recorded: RecordedStepFields) => recorded),
  })
);
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
