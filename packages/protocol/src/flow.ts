import { Effect, Schema, SchemaGetter } from "effect";

import { BrowserTabId, SessionId } from "./browser-identifiers.ts";
import {
  BrowserIdentity,
  matchUserAgentProfile,
  profileViewport,
  resolveIdentity,
  UserAgentProfileId,
} from "./browser-identity.ts";
import { Viewport } from "./viewport.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Stable identity for a Flow, independent of its user-editable title. */
export const FlowId = nonEmptyString.pipe(Schema.brand("@contingency/FlowId"));
export type FlowId = typeof FlowId.Type;

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * One way to find a Step's element ([ADR
 * 0011](../../../docs/adr/0011-flow-is-a-native-format.md)).
 */
export const RoleLocator = Schema.Struct({
  kind: Schema.Literal("role"),
  /** The element's accessible name, e.g. `Add to cart`. */
  name: nonEmptyString,
  /** The element's ARIA role, e.g. `button`. */
  role: nonEmptyString,
});
export type RoleLocator = typeof RoleLocator.Type;

export const LabelLocator = Schema.Struct({
  kind: Schema.Literal("label"),
  label: nonEmptyString,
});
export type LabelLocator = typeof LabelLocator.Type;

export const PlaceholderLocator = Schema.Struct({
  kind: Schema.Literal("placeholder"),
  placeholder: nonEmptyString,
});
export type PlaceholderLocator = typeof PlaceholderLocator.Type;

export const TextLocator = Schema.Struct({
  kind: Schema.Literal("text"),
  text: nonEmptyString,
});
export type TextLocator = typeof TextLocator.Type;

export const CssLocator = Schema.Struct({
  kind: Schema.Literal("css"),
  selector: nonEmptyString,
});
export type CssLocator = typeof CssLocator.Type;

export const XpathLocator = Schema.Struct({
  expression: nonEmptyString,
  kind: Schema.Literal("xpath"),
});
export type XpathLocator = typeof XpathLocator.Type;

/**
 * One way to find a Step's element. A Step names its target through an
 * {@link Target} of these descriptors, resolved first-match-wins, so a Flow
 * survives a site changing one of them.
 *
 * The recorded ladder is role and accessible name, then label, then
 * placeholder, then text, then CSS, then XPath: the most meaningful strategy
 * for accessibility work leads, the positional one that breaks first is last.
 * There is deliberately no test-id kind — Contingency audits sites it does not
 * own, so test IDs are usually absent.
 */
export const LocatorDescriptor = Schema.Union([
  RoleLocator,
  LabelLocator,
  PlaceholderLocator,
  TextLocator,
  CssLocator,
  XpathLocator,
]);
export type LocatorDescriptor = typeof LocatorDescriptor.Type;

/** Exhaustive dispatch for the closed locator vocabulary. */
export interface LocatorDescriptorCases<A> {
  readonly css: (descriptor: CssLocator) => A;
  readonly label: (descriptor: LabelLocator) => A;
  readonly placeholder: (descriptor: PlaceholderLocator) => A;
  readonly role: (descriptor: RoleLocator) => A;
  readonly text: (descriptor: TextLocator) => A;
  readonly xpath: (descriptor: XpathLocator) => A;
}

/**
 * Interpret one locator descriptor without repeating the protocol's kind
 * switch in every consumer. Adding a kind now makes the dispatcher and every
 * handler set fail to compile together.
 */
export const matchLocatorDescriptor = <A>(
  descriptor: LocatorDescriptor,
  cases: LocatorDescriptorCases<A>
): A => {
  switch (descriptor.kind) {
    case "role": {
      return cases.role(descriptor);
    }
    case "label": {
      return cases.label(descriptor);
    }
    case "placeholder": {
      return cases.placeholder(descriptor);
    }
    case "text": {
      return cases.text(descriptor);
    }
    case "css": {
      return cases.css(descriptor);
    }
    case "xpath": {
      return cases.xpath(descriptor);
    }
    default: {
      const unhandled: never = descriptor;
      return unhandled;
    }
  }
};

/**
 * The ordered alternatives a Step tries when finding its element, resolved
 * first-match-wins. Every Step that acts on an element carries at least one.
 *
 * A target here is authored. [docs/future/agent-flow.md](../../../docs/future/agent-flow.md)
 * reserves room for a Step whose concrete action path is derived per
 * environment instead; nothing in this model assumes that case exists yet, and
 * nothing is built for it.
 */
export const Target = Schema.Array(LocatorDescriptor).check(
  Schema.isMinLength(1)
);
export type Target = typeof Target.Type;

// ---------------------------------------------------------------------------
// Pages and conditions
// ---------------------------------------------------------------------------

/**
 * Which Page a Step acts on, by the order it opened. Absent means the first
 * Page, so a single-Page Flow carries no Page syntax.
 */
export const PageIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type PageIndex = typeof PageIndex.Type;

/**
 * Why a Pre-step or `waitFor` Step acts: a closed set of named conditions
 * ([ADR 0022](../../../docs/adr/0022-pre-step-conditions-gain-hidden-and-url.md)),
 * not an expression language. An unanswerable condition stays distinct from a
 * false one ([ADR 0009](../../../docs/adr/0009-run-execution-semantics.md)).
 */
export const ConditionSelectorVisible = Schema.Struct({
  target: Target,
  type: Schema.Literal("selectorVisible"),
});

export const ConditionSelectorHidden = Schema.Struct({
  target: Target,
  type: Schema.Literal("selectorHidden"),
});

/** A URL pattern the current Page must match, e.g. `/cart$`. */
export const ConditionUrlMatches = Schema.Struct({
  pattern: nonEmptyString,
  type: Schema.Literal("urlMatches"),
});

export const Condition = Schema.Union([
  ConditionSelectorVisible,
  ConditionSelectorHidden,
  ConditionUrlMatches,
]);
export type Condition = typeof Condition.Type;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const pageField = Schema.optional(PageIndex);
const timeoutField = Schema.optional(Schema.Finite);

/**
 * Per-Step timeouts are set explicitly rather than inherited from the Run's
 * wall-clock ceiling ([ADR
 * 0021](../../../docs/adr/0021-timeouts-are-set-not-inherited.md)).
 */
const actionFields = {
  page: pageField,
  timeout: timeoutField,
};

export const NavigateStep = Schema.Struct({
  ...actionFields,
  type: Schema.Literal("navigate"),
  url: nonEmptyString,
});
export type NavigateStep = typeof NavigateStep.Type;

const targetedFields = {
  ...actionFields,
  target: Target,
};

export const ClickStep = Schema.Struct({
  ...targetedFields,
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  type: Schema.Literal("click"),
});
export type ClickStep = typeof ClickStep.Type;

export const ChangeStep = Schema.Struct({
  ...targetedFields,
  type: Schema.Literal("change"),
  value: Schema.String,
});
export type ChangeStep = typeof ChangeStep.Type;

/**
 * Half of a pressed key. Carries a target when the keystroke belongs to an
 * element — typing into a field — and none for Page-level keyboard events.
 */
export const KeyStep = Schema.Struct({
  ...actionFields,
  key: nonEmptyString,
  target: Schema.optional(Target),
  type: Schema.Literals(["keyDown", "keyUp"]),
});
export type KeyStep = typeof KeyStep.Type;

/**
 * A single keystroke: one Step rather than a keyDown and keyUp pair. Carries a
 * target when the keystroke belongs to an element, and none for Page-level
 * shortcuts.
 */
export const PressStep = Schema.Struct({
  ...actionFields,
  key: nonEmptyString,
  target: Schema.optional(Target),
  type: Schema.Literal("press"),
});
export type PressStep = typeof PressStep.Type;

export const HoverStep = Schema.Struct({
  ...targetedFields,
  type: Schema.Literal("hover"),
});
export type HoverStep = typeof HoverStep.Type;

/**
 * One scroll per resting position, never a log of wheel ticks. Deltas are
 * absent-meaning-zero rather than required, so a Flow can express a plain
 * scroll to top. An omitted target means the document; an element scroll
 * retains the same ordered locator ladder as any other targeted Step.
 */
export const ScrollStep = Schema.Struct({
  ...actionFields,
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  target: Schema.optional(Target),
  type: Schema.Literal("scroll"),
});
export type ScrollStep = typeof ScrollStep.Type;

export const SelectOptionStep = Schema.Struct({
  ...targetedFields,
  type: Schema.Literal("selectOption"),
  values: Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
});
export type SelectOptionStep = typeof SelectOptionStep.Type;

/**
 * Waits until its condition holds — the same condition machinery a Pre-step
 * uses ([ADR 0022](../../../docs/adr/0022-pre-step-conditions-gain-hidden-and-url.md))
 * — so a Flow can wait out a spinner before an Audit runs.
 */
export const WaitForStep = Schema.Struct({
  ...actionFields,
  condition: Condition,
  type: Schema.Literal("waitFor"),
});
export type WaitForStep = typeof WaitForStep.Type;

/**
 * A browser action as recorded or authored, without the fields authoring adds
 * ({@link AuthoredStep}). A Recording captures these; a Flow persists their
 * authored form.
 */
export const BrowserActionStep = Schema.Union([
  NavigateStep,
  ClickStep,
  ChangeStep,
  KeyStep,
  PressStep,
  HoverStep,
  ScrollStep,
  SelectOptionStep,
  WaitForStep,
]);
export type BrowserActionStep = typeof BrowserActionStep.Type;

/**
 * What a Pre-step may act with: anything that clears interference — ads,
 * popups, cross-sells. A Pre-step does not navigate, and waiting is what its
 * own condition is for.
 */
const preStepActionSchemas = [
  ClickStep,
  ChangeStep,
  KeyStep,
  PressStep,
  HoverStep,
  ScrollStep,
  SelectOptionStep,
];

export const PreStep = Schema.Struct({
  id: nonEmptyString,
  step: Schema.Union(preStepActionSchemas),
  when: Condition,
});
export type PreStep = typeof PreStep.Type;

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
 * `wcag21a` is absent because the engine has no rules under it: a tag
 * selecting nothing is indistinguishable from a misspelled one, and both audit
 * every page clean.
 */
export const accessibilityRuleTags = [
  "wcag2a",
  "wcag2aa",
  "wcag21aa",
  "wcag22aa",
] as const;

/**
 * An accessibility Audit as an ordered Step ([ADR
 * 0005](../../../docs/adr/0005-audits-are-ordered-custom-steps.md)). Running
 * it produces Findings at this point in the Flow. Performance is not an
 * Audit: it is the `performance` toggle on a navigating Step.
 */
export const AuditStep = Schema.Struct({
  kind: AuditKind,
  type: Schema.Literal("audit"),
});
export type AuditStep = typeof AuditStep.Type;

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

// ---------------------------------------------------------------------------
// Authored Steps and the Flow document
// ---------------------------------------------------------------------------

/**
 * The fields authoring adds to a recorded action: identity, the Core Web
 * Vitals toggle, Pre-steps, and a Variable binding. There is no `contingency`
 * extension wrapper any more — the Flow is Contingency's own document ([ADR
 * 0011](../../../docs/adr/0011-flow-is-a-native-format.md)), so these are
 * ordinary fields.
 */
const authoredFields = {
  id: Schema.optional(nonEmptyString),
  /**
   * Collect Core Web Vitals at this Step's navigation. Only meaningful on a
   * Step that navigates, and rejected by {@link Flow} anywhere else ([ADR
   * 0008](../../../docs/adr/0008-performance-is-a-navigation-step-toggle.md)).
   */
  performance: Schema.optional(Schema.Boolean),
  preSteps: Schema.optional(Schema.Array(PreStep)),
  /**
   * A Variable binding: the named Variable's value substitutes `{{NAME}}` in
   * this Step's fields at Run time. Meaningful where a Step supplies input —
   * a change Step's value, most commonly.
   */
  variable: Schema.optional(nonEmptyString),
} as const;

const AuthoredNavigateStep = Schema.Struct({
  ...NavigateStep.fields,
  ...authoredFields,
});
const AuthoredClickStep = Schema.Struct({
  ...ClickStep.fields,
  ...authoredFields,
});
const AuthoredChangeStep = Schema.Struct({
  ...ChangeStep.fields,
  ...authoredFields,
});
const AuthoredKeyStep = Schema.Struct({
  ...KeyStep.fields,
  ...authoredFields,
});
const AuthoredPressStep = Schema.Struct({
  ...PressStep.fields,
  ...authoredFields,
});
const AuthoredHoverStep = Schema.Struct({
  ...HoverStep.fields,
  ...authoredFields,
});
const AuthoredScrollStep = Schema.Struct({
  ...ScrollStep.fields,
  ...authoredFields,
});
const AuthoredSelectOptionStep = Schema.Struct({
  ...SelectOptionStep.fields,
  ...authoredFields,
});
const AuthoredWaitForStep = Schema.Struct({
  ...WaitForStep.fields,
  ...authoredFields,
});
const AuthoredAuditStep = Schema.Struct({
  ...AuditStep.fields,
  ...authoredFields,
});

/**
 * One ordered unit in a Flow: a browser action or an Audit Step, each carrying
 * the authored fields. Members are the authored forms of the exported action
 * schemas, so decode errors and tooling name them.
 */
export const AuthoredStep = Schema.Union([
  AuthoredNavigateStep,
  AuthoredClickStep,
  AuthoredChangeStep,
  AuthoredKeyStep,
  AuthoredPressStep,
  AuthoredHoverStep,
  AuthoredScrollStep,
  AuthoredSelectOptionStep,
  AuthoredWaitForStep,
  AuthoredAuditStep,
]);
export type AuthoredStep = typeof AuthoredStep.Type;

/**
 * A Step navigates when it is a `navigate` Step — the only Step whose
 * navigation is declared rather than incidental, and the only one Core Web
 * Vitals measurement can anchor on.
 */
export const stepNavigates = (step: AuthoredStep): boolean =>
  step.type === "navigate";

// `performance` on a Step that cannot navigate is malformed wherever it is
// read, so the schema rejects it rather than silently ignoring it (ADR 0008).
const performanceOnlyOnNavigatingSteps = Schema.makeFilter<
  readonly AuthoredStep[]
>((steps) =>
  steps.flatMap((step, index) => {
    if (step.performance !== true || stepNavigates(step)) {
      return [];
    }
    const label =
      step.id === undefined
        ? `Step ${index + 1} (${step.type})`
        : `Step ${index + 1} (${step.type}, id ${step.id})`;
    return [
      {
        issue:
          `${label} cannot navigate, so it cannot measure performance. ` +
          "Set performance only on a navigate Step.",
        path: [index, "performance"],
      },
    ];
  })
);

/**
 * The two answers a Flow can give about a website permission. Chromium's own
 * `prompt` is absent deliberately: the native bubble sits outside the streamed
 * page, so it is neither operable in Create View nor reproducible in a Run
 * ([ADR 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const PermissionState = Schema.Literals(["granted", "denied"]);
export type PermissionState = typeof PermissionState.Type;

/**
 * One explicit website permission decision and where it applies. Absent
 * `origin` means the decision is context-wide; an origin narrows it to that
 * site. Flows written before decisions were explicit list grants only, so a
 * missing `state` decodes as `granted` rather than as an absent answer.
 */
export const PermissionDecision = Schema.Struct({
  origin: Schema.optional(nonEmptyString),
  /** The engine's permission name, e.g. `geolocation`. */
  permission: nonEmptyString,
  state: PermissionState.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("granted" as const))
  ),
});
export type PermissionDecision = typeof PermissionDecision.Type;

const decisionScope = (decision: PermissionDecision): string =>
  decision.origin ?? "*";

/**
 * Reject decision sets no browser could reproduce. One scope saying both
 * `granted` and `denied` about a permission has no answer, and Chromium's
 * context-wide grant cannot be narrowed back down for a single origin, so a
 * context-wide grant beside an origin denial would silently grant.
 */
const coherentPermissionDecisions = Schema.makeFilter<
  readonly PermissionDecision[]
>((decisions) => {
  const issues: { readonly issue: string; readonly path: readonly number[] }[] =
    [];
  const seen = new Map<string, PermissionState>();
  for (const [index, decision] of decisions.entries()) {
    const key = `${decision.permission}@${decisionScope(decision)}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== decision.state) {
      issues.push({
        issue:
          `The ${decision.permission} permission is both granted and denied ` +
          `for ${decision.origin ?? "every origin"}. Declare one decision per scope.`,
        path: [index],
      });
    }
    seen.set(key, decision.state);
  }
  for (const [index, decision] of decisions.entries()) {
    if (decision.origin === undefined || decision.state !== "denied") {
      continue;
    }
    const grantedEverywhere = decisions.some(
      (other) =>
        other.origin === undefined &&
        other.permission === decision.permission &&
        other.state === "granted"
    );
    if (grantedEverywhere) {
      issues.push({
        issue:
          `The ${decision.permission} permission is granted to every origin, ` +
          `so it cannot also be denied to ${decision.origin}. Grant it to the ` +
          "origins that may have it instead.",
        path: [index],
      });
    }
  }
  return issues;
});

/**
 * A whole set of permission decisions, coherent as a set. Create View's live
 * session, the RPC that patches it, and the Flow all carry this one shape, so
 * a set the session accepts is a set the Flow can be saved with rather than
 * one the author discovers is unwritable later.
 */
export const PermissionDecisions = Schema.Array(PermissionDecision).check(
  coherentPermissionDecisions
);
export type PermissionDecisions = typeof PermissionDecisions.Type;

export const Geolocation = Schema.Struct({
  accuracy: Schema.optional(Schema.Finite),
  latitude: Schema.Finite.check(
    Schema.isBetween({ maximum: 90, minimum: -90 })
  ),
  longitude: Schema.Finite.check(
    Schema.isBetween({ maximum: 180, minimum: -180 })
  ),
});
export type Geolocation = typeof Geolocation.Type;

/**
 * The device and environment characteristics a Flow declares and every Run
 * reproduces ([ADR 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 * Emulated geolocation is the location a site receives when it asks for the
 * current position. Fields the Flow does not declare stay at their defaults;
 * `offline` and extra HTTP headers are deferred.
 */
export const Emulation = Schema.Struct({
  /**
   * The concrete browser the Flow presents, applied identically by Create View
   * and every Run. It supersedes `userAgent`, which stays for Flows written
   * before an identity was concrete and for custom strings that declare
   * nothing further.
   */
  browser: Schema.optional(BrowserIdentity),
  colorScheme: Schema.optional(Schema.Literals(["light", "dark"])),
  geolocation: Schema.optional(Geolocation),
  locale: Schema.optional(nonEmptyString),
  permissions: Schema.optional(
    PermissionDecisions.check(Schema.isMinLength(1))
  ),
  timezoneId: Schema.optional(nonEmptyString),
  userAgent: Schema.optional(nonEmptyString),
  viewport: Schema.optional(Viewport),
});
export type Emulation = typeof Emulation.Type;

/**
 * The accessibility rule ids a Run must produce no Finding against. Breaching
 * a Gate makes the CLI exit non-zero without failing the Run ([ADR
 * 0018](../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)):
 * the site missed the bar, the Run executed fine, so a breaching Run stays
 * eligible as a Baseline.
 */
export const Gate = Schema.Array(nonEmptyString).check(Schema.isMinLength(1));
export type Gate = typeof Gate.Type;

/**
 * Contingency's primary durable artifact: a native JSON document declaring
 * ordered Steps, conditional Pre-steps, Variables, Emulation, and a Gate
 * ([ADR 0011](../../../docs/adr/0011-flow-is-a-native-format.md)). Chrome
 * DevTools Recorder compatibility and import are dropped entirely. The one
 * deliberate compatibility fold is an older known browser profile string
 * into its concrete identity. Documents carrying old selector arrays, frame
 * indices, asserted events, targets-as-strings, or a video flag are rejected,
 * not migrated.
 *
 * Strictness lives here, not at the call site: unknown fields are a decode
 * error, because a document from another era must be rejected rather than
 * silently stripped of whatever the author meant.
 */
const FlowDocument = Schema.Struct({
  emulation: Schema.optional(Emulation),
  /**
   * Stable identity for the Flow, independent of its user-editable title, so
   * Run history survives a rename.
   */
  flowId: Schema.optional(FlowId),
  gate: Schema.optional(Gate),
  /**
   * Opt into carrying browser state between Runs: each Run still starts from
   * whatever state the previous one saved rather than from nothing, so a Flow
   * that depends on being logged in carries that deliberately. Absent — the
   * default — means every Run executes in a fresh context (ADR 0015).
   */
  persistedState: Schema.optional(Schema.Boolean),
  /** Pre-steps that run before every Step after the initial navigation. */
  preSteps: Schema.optional(Schema.Array(PreStep)),
  steps: Schema.Array(AuthoredStep).check(
    Schema.isMinLength(1),
    performanceOnlyOnNavigatingSteps
  ),
  /**
   * The Run's wall-clock ceiling. Per-Step timeouts are set on the Steps
   * themselves, not inherited from this ([ADR
   * 0021](../../../docs/adr/0021-timeouts-are-set-not-inherited.md)).
   */
  timeout: Schema.optional(Schema.Finite),
  title: nonEmptyString,
  variables: Schema.optional(Schema.Array(Variable)),
}).annotate({
  identifier: "Flow",
  parseOptions: { onExcessProperty: "error" },
});

type FlowDocument = typeof FlowDocument.Type;

const normalizeOlderBrowserIdentity = (flow: FlowDocument): FlowDocument => {
  const { emulation } = flow;
  if (emulation?.browser !== undefined || emulation?.userAgent === undefined) {
    return flow;
  }
  const matched = matchUserAgentProfile(emulation.userAgent);
  if (matched === undefined || !matched.profile.selectable) {
    return flow;
  }
  const browser = resolveIdentity(matched.profile.id, matched.browserVersion);
  if (browser === undefined) {
    return flow;
  }
  const { userAgent: _, ...current } = emulation;
  const viewport = current.viewport ?? profileViewport(matched.profile.id);
  return {
    ...flow,
    emulation: {
      ...current,
      browser,
      ...(viewport === undefined ? {} : { viewport }),
    },
  };
};

export const Flow = FlowDocument.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(normalizeOlderBrowserIdentity),
    encode: SchemaGetter.transform((flow) => flow),
  })
);
export type Flow = typeof Flow.Type;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

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
  "hoverPicker",
]);
export type RecordingCaptureMode = typeof RecordingCaptureMode.Type;

export const RecordedStep = Schema.Struct({
  id: nonEmptyString,
  preSteps: Schema.Array(PreStep),
  step: Schema.Union([BrowserActionStep, AuditStep]),
  variable: Schema.optional(nonEmptyString),
});
export type RecordedStep = typeof RecordedStep.Type;

export const hasAuthoredBrowserStep = (
  recordedSteps: readonly RecordedStep[]
): boolean =>
  recordedSteps.some(({ step }, index) => index > 0 && step.type !== "audit");

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
}).annotate({
  identifier: "RecordingSnapshot",
  parseOptions: { onExcessProperty: "error" },
});
export type RecordingSnapshot = typeof RecordingSnapshot.Type;

export const recordingMakesBrowserInputReadOnly = (
  recording: Pick<RecordingSnapshot, "captureMode" | "phase"> | null
): boolean =>
  recording?.phase === "incomplete" ||
  (recording?.phase === "paused" && recording.captureMode === "ordinary");

/**
 * A Recording that has captured Steps declares the Emulation those Steps were
 * captured under, so the session's Emulation, viewport, and user agent stay
 * locked until the Recording is finished — including while it sits
 * `incomplete`, because `recover()` resumes onto the very same Steps.
 */
export const recordingLocksBrowserControls = (
  recording: Pick<RecordingSnapshot, "phase" | "sessionId"> | null,
  sessionId: string
): boolean =>
  recording !== null &&
  recording.sessionId === sessionId &&
  recording.phase !== "finished";

/**
 * Whether a Recording still holds the browser. A Run is context-isolated and a
 * Recording drives a live session, so the two cannot share the process
 * ([ADR 0023](../../../docs/adr/0023-audit-view-starts-runs.md)): starting a
 * Run while this holds is refused rather than contended for. Unlike the
 * control locks, this is not scoped to a session — a Run belongs to no
 * session, and any unfinished Recording is enough to refuse it.
 */
export const recordingIsInProgress = (
  recording: Pick<RecordingSnapshot, "phase"> | null
): boolean => recording !== null && recording.phase !== "finished";

export const recordingLocksStorageMutations = (
  recording: Pick<RecordingSnapshot, "phase" | "sessionId"> | null,
  sessionId: string
): boolean =>
  recording !== null &&
  recording.sessionId === sessionId &&
  recording.phase !== "finished";

/**
 * One whole Emulation composed but not yet applied to any session: the browser
 * identity, its viewport, and the environment around it as a single value. It
 * travels with the first navigation so the session's first request and document
 * already carry it, rather than being patched in afterwards ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const DraftEmulation = Schema.Struct({
  colorScheme: Schema.optional(Schema.Literals(["light", "dark"])),
  geolocation: Schema.optional(Geolocation),
  locale: Schema.optional(nonEmptyString),
  permissions: PermissionDecisions,
  timezoneId: Schema.optional(nonEmptyString),
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
});
export type DraftEmulation = typeof DraftEmulation.Type;
