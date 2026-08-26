import { Schema } from "effect";

import { Flow } from "./flow.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** ISO 8601 instant, so a Run stays readable and diffable on disk. */
const Instant = nonEmptyString;

export const RunOutcome = Schema.Literals(["completed", "failed"]);
export type RunOutcome = typeof RunOutcome.Type;

export const RunStepOutcome = Schema.Literals(["completed", "failed"]);
export type RunStepOutcome = typeof RunStepOutcome.Type;

/**
 * Whether a Pre-step acted. `skipped` means its condition did not hold, so the
 * interference it clears was not there. `failed` means its condition held but
 * the action did not work; the Run continues either way (ADR 0009).
 */
export const RunPreStepOutcome = Schema.Literals([
  "completed",
  "skipped",
  "failed",
]);
export type RunPreStepOutcome = typeof RunPreStepOutcome.Type;

/**
 * Which strategy a candidate used, matching the {@link Flow} locator kinds. It
 * travels on the diagnostic so a reader can see which rungs of the ladder
 * broke and which were never reached, without re-deriving them from the Flow.
 */
export const LocatorStrategy = Schema.Literals([
  "role",
  "label",
  "placeholder",
  "text",
  "css",
  "xpath",
]);
export type LocatorStrategy = typeof LocatorStrategy.Type;

/**
 * Why a candidate did not resolve.
 *
 * `absent` and `ambiguous` are the pair that matters most, and the pair the
 * previous runtime could not tell apart: one means the Flow names something
 * that is gone, the other means it names something the page now has several
 * of. They are different repairs. `hidden` and `detached` mean the page has
 * the element but not in a state that can be acted on, and `unactionable`
 * covers the rest — matched, visible, attached, and still refusing the action
 * — rather than mislabelling it as one of the four.
 */
export const LocatorMiss = Schema.Literals([
  "absent",
  "ambiguous",
  "hidden",
  "detached",
  "unactionable",
]);
export type LocatorMiss = typeof LocatorMiss.Type;

/** One alternative a Step tried, and what the page answered. */
export const SelectorCandidate = Schema.Struct({
  /**
   * The browser's own one-line reason, when it says something the miss does
   * not. Redacted like every other message a Run persists.
   */
  detail: Schema.optional(nonEmptyString),
  /** What this candidate looked for, in words rather than as a raw path. */
  lookedFor: nonEmptyString,
  /** How many elements matched. Present on `ambiguous`. */
  matches: Schema.optional(Schema.Int),
  miss: LocatorMiss,
  strategy: LocatorStrategy,
});
export type SelectorCandidate = typeof SelectorCandidate.Type;

/**
 * An element the page actually had when a Step could not find its target. A
 * renamed button appears here under its new name, which is what makes a rename
 * visibly different from a removal.
 */
export const NearbyElement = Schema.Struct({
  name: nonEmptyString,
  role: nonEmptyString,
});
export type NearbyElement = typeof NearbyElement.Type;

/**
 * Everything a resolution failure knows: every candidate tried — not only the
 * last — and the nearest elements that were present.
 */
export const SelectorDiagnostics = Schema.Struct({
  candidates: Schema.Array(SelectorCandidate),
  /**
   * Absent when the page could not be read at all, which is not the same as a
   * page that had nothing to report.
   */
  nearest: Schema.optional(Schema.Array(NearbyElement)),
});
export type SelectorDiagnostics = typeof SelectorDiagnostics.Type;

/**
 * One Pre-step evaluation, recorded whether it ran or not. A silently-skipped
 * Pre-step is the first thing anyone looks for when a Run differs unexpectedly
 * from its Baseline, so the record is kept even when nothing happened.
 */
export const RunPreStep = Schema.Struct({
  error: Schema.optional(Schema.String),
  outcome: RunPreStepOutcome,
  preStepId: nonEmptyString,
  /** `flow` Pre-steps run before every Step after the initial navigation. */
  scope: Schema.Literals(["flow", "step"]),
  /** Present when this Pre-step failed because its target did not resolve. */
  selector: Schema.optional(SelectorDiagnostics),
});
export type RunPreStep = typeof RunPreStep.Type;

/**
 * How bad a Finding is. These are the accessibility engine's own four impact
 * levels, verbatim. A Contingency-specific scale would mean a mapping table to
 * defend forever, and a second one the day a second Audit kind arrives.
 */
export const FindingSeverity = Schema.Literals([
  "minor",
  "moderate",
  "serious",
  "critical",
]);
export type FindingSeverity = typeof FindingSeverity.Type;

/**
 * One accessibility violation, at one element, found by one Audit Step.
 *
 * A Finding never influences a Run's outcome or the CLI's exit code. Every
 * real site has pre-existing violations, and failing a build on their count
 * makes it red on day one, after which the check gets switched off. What
 * should break a build is a Regression, which is separate work.
 */
export const Finding = Schema.Struct({
  /** The engine's fix guidance for this rule. */
  helpUrl: Schema.optional(nonEmptyString),
  message: nonEmptyString,
  /** The engine's rule id, e.g. `image-alt`. */
  rule: nonEmptyString,
  severity: FindingSeverity,
  /** Position of the Audit Step that produced it, in executed Flow order. */
  stepIndex: Schema.Int,
  /**
   * How to find the element. Rendered rather than structured, because the one
   * thing anyone does with a target is look for the element it names: hops
   * across a frame boundary are joined with ` >>> ` and into a shadow root
   * with ` >> `, matching how the browser tooling writes piercing selectors.
   */
  target: nonEmptyString,
});
export type Finding = typeof Finding.Type;

/**
 * Core Web Vitals for one navigation, in milliseconds except {@link
 * CoreWebVitals.cls}, which is a unitless score.
 *
 * Every metric but CLS is optional, and absence means the page produced no
 * such measurement rather than zero. A page interacted with before it settles
 * reports no LCP, a navigation nobody interacted with reports no INP, and a
 * document that did not come from the network reports no TTFB. Recording those
 * as `0` would make the fastest possible page indistinguishable from an
 * unmeasured one.
 *
 * Numbers are unthrottled, so they describe the host machine as much as the
 * site (ADR 0008) — see {@link RunEnvironment}.
 */
export const CoreWebVitals = Schema.Struct({
  /** Cumulative Layout Shift: the worst session window, not the total. */
  cls: Schema.Number,
  fcp: Schema.optional(Schema.Number),
  inp: Schema.optional(Schema.Number),
  lcp: Schema.optional(Schema.Number),
  ttfb: Schema.optional(Schema.Number),
});
export type CoreWebVitals = typeof CoreWebVitals.Type;

/**
 * The machine a Run was measured on. Core Web Vitals are collected
 * unthrottled, so a Baseline recorded on a laptop and compared against a busy
 * CI runner reads as a Regression caused entirely by hardware (ADR 0008).
 *
 * This is what a later comparison needs to notice that two Runs are not
 * comparable. Deciding what to do about it belongs with Regressions; a Run
 * that does not record it cannot be rescued later, which is why it is here.
 */
export const RunEnvironment = Schema.Struct({
  architecture: nonEmptyString,
  /**
   * The version of the accessibility engine that produced this Run's Findings
   * (ADR 0017). Absent when the Run audited nothing, so there was no engine to
   * record. A Baseline comparison that crosses an engine upgrade warns rather
   * than refuses — see {@link axeVersionMismatchWarning} — because rule churn
   * between versions describes the engine, not the site.
   */
  axeVersion: Schema.optional(nonEmptyString),
  cpuCount: Schema.Int,
  cpuModel: nonEmptyString,
  /**
   * System load at the moment the Run started, averaged over one minute. Two
   * Runs on identical hardware are still not comparable if one shared its
   * machine with a build; `0` on a platform that does not report it.
   */
  loadAverage: Schema.Number,
  memoryBytes: Schema.Int,
  /**
   * How navigation readiness was established. Absent on Runs written before
   * ADR 0015 made the bounded post-load network-idle wait explicit.
   */
  navigationReadiness: Schema.optional(
    Schema.Literal("load-then-bounded-network-idle")
  ),
  platform: nonEmptyString,
});
export type RunEnvironment = typeof RunEnvironment.Type;

/**
 * A rule the engine reported only in part.
 *
 * The engine itself reports every element a rule failed on; the cap on how
 * many are listed is Contingency's own, chosen and written down (ADR 0017):
 * ten per rule. A rule failing on four hundred elements says so once with its
 * true count rather than producing four hundred Findings, while the listed
 * sample still names where to start.
 *
 * Recording the shortfall keeps a later Baseline comparison honest. Without
 * it, a page whose violations grew past the cap and a page that genuinely
 * improved to the cap produce the same Findings, and the Regression that
 * matters is the one that stays invisible.
 */
export const ElidedFindings = Schema.Struct({
  /** How many the Run holds Findings for. */
  reported: Schema.Int,
  rule: nonEmptyString,
  severity: FindingSeverity,
  stepIndex: Schema.Int,
  /** How many the engine says the page has. */
  total: Schema.Int,
});
export type ElidedFindings = typeof ElidedFindings.Type;

/**
 * One executed Step, recorded whether it succeeded or not. `index` is the
 * Step's position in the executed Flow, so a Run reads against its own
 * embedded Flow without a separate lookup.
 */
export const RunStep = Schema.Struct({
  /**
   * Rules whose violations this Step's Findings represent only in part.
   * Absent when every violation the engine counted is also listed.
   */
  elidedFindings: Schema.optional(Schema.Array(ElidedFindings)),
  error: Schema.optional(Schema.String),
  /** Everything an Audit Step found. Absent on Steps that audit nothing. */
  findings: Schema.optional(Schema.Array(Finding)),
  finishedAt: Instant,
  index: Schema.Int,
  outcome: RunStepOutcome,
  /** Every Pre-step evaluated before this Step, in evaluation order. */
  preSteps: Schema.optional(Schema.Array(RunPreStep)),
  /** Present when this Step failed because its target did not resolve. */
  selector: Schema.optional(SelectorDiagnostics),
  startedAt: Instant,
  stepId: Schema.optional(Schema.String),
  type: nonEmptyString,
  /**
   * Core Web Vitals for the navigation this Step performed. Present only on a
   * Step carrying the performance toggle (ADR 0008).
   */
  vitals: Schema.optional(CoreWebVitals),
});
export type RunStep = typeof RunStep.Type;

/**
 * Who a failure belongs to. `siteError` means the site under test is broken —
 * a navigation that did not complete, or a document the server answered with
 * an error status — which is the signal Contingency exists to catch.
 * `flowError` means the Flow has gone stale and needs re-authoring, typically a
 * selector that no longer resolves.
 *
 * They route to different people, so collapsing them into one channel makes
 * that channel ignorable once Alerts exist.
 */
export const RunFailureKind = Schema.Literals(["siteError", "flowError"]);
export type RunFailureKind = typeof RunFailureKind.Type;

/**
 * Why a Run did not complete. `kind` is absent when the failure belongs to
 * neither party — a Run that exceeded its own wall-clock ceiling has no single
 * failing Step to attribute, and guessing would route it to the wrong person.
 */
export const RunFailure = Schema.Struct({
  kind: Schema.optional(RunFailureKind),
  message: nonEmptyString,
  stepIndex: Schema.optional(Schema.Int),
});
export type RunFailure = typeof RunFailure.Type;

/**
 * One attempt at executing the Flow. Every attempt is recorded, including the
 * failures that preceded a later attempt's success: silent retry is how a Flow
 * that fails 40% of the time reports green for a month.
 */
export const RunAttempt = Schema.Struct({
  /** 1-based, so `attempt: 1` is the first try rather than the first retry. */
  attempt: Schema.Int,
  failure: Schema.optional(RunFailure),
  finishedAt: Instant,
  outcome: RunOutcome,
  startedAt: Instant,
  steps: Schema.Array(RunStep),
});
export type RunAttempt = typeof RunAttempt.Type;

/**
 * One attempt's derived video. `file` is relative to the Run's directory, so a
 * Run stays portable when it is copied somewhere else.
 *
 * A derivation that produced no file is still recorded, with the reason. Video
 * is an observation aid, so an artifact failure never fails the Run.
 */
export const RunVideoSegment = Schema.Struct({
  attempt: Schema.Int,
  error: Schema.optional(nonEmptyString),
  file: nonEmptyString,
  /** Whether the video ends on a frame captured after the final quiet wait. */
  includesSettledState: Schema.Boolean,
  recorded: Schema.Boolean,
  /** The executed Step indexes represented by frames in this video. */
  steps: Schema.Array(Schema.Int),
});
export type RunVideoSegment = typeof RunVideoSegment.Type;

/**
 * The videos generated for a Run, written beside it.
 *
 * Frames come from the sensitive Trace, so a derived video may render a secret
 * value that `run.json` redacts. {@link RunVideoManifest.containsSecrets} lets
 * a future upload adapter refuse it by default (ADR 0014).
 */
export const RunVideoManifest = Schema.Struct({
  /** The Run handled a secret Variable, so the video may show one. */
  containsSecrets: Schema.Boolean,
  runId: nonEmptyString,
  /** One per attempt: the attempt worth watching is usually the failed one. */
  segments: Schema.Array(RunVideoSegment),
});
export type RunVideoManifest = typeof RunVideoManifest.Type;

/** One attempt's Playwright trace archive. */
export const RunTraceSegment = Schema.Struct({
  attempt: Schema.Int,
  error: Schema.optional(nonEmptyString),
  file: nonEmptyString,
  recorded: Schema.Boolean,
});
export type RunTraceSegment = typeof RunTraceSegment.Type;

/**
 * The Trace artifacts written beside a Run.
 *
 * Trace DOM snapshots and network payloads can contain credentials. Exact
 * secret values are scrubbed from text entries where possible, but callers
 * must still treat every Trace as sensitive because completeness cannot be
 * proven (ADR 0014).
 */
export const RunTraceManifest = Schema.Struct({
  /** The Run handled a secret Variable, so the Trace may contain one. */
  containsSecrets: Schema.Boolean,
  runId: nonEmptyString,
  scrubbing: Schema.Literal("best-effort"),
  segments: Schema.Array(RunTraceSegment),
});
export type RunTraceManifest = typeof RunTraceManifest.Type;

/**
 * One execution of a Flow. Self-contained: it embeds the Flow it executed plus
 * that Flow's content hash, so a Run stays interpretable when it travels
 * without its Flow file, and so a later Baseline comparison can cheaply detect
 * that the Flow changed underneath it (ADR 0009).
 */
export const Run = Schema.Struct({
  /**
   * Every attempt, in order. A Run that completed on its first try has one
   * entry; {@link Run.steps} always mirrors the last attempt's.
   */
  attempts: Schema.Array(RunAttempt).check(Schema.isMinLength(1)),
  /** The machine that produced this Run's measurements. */
  environment: RunEnvironment,
  failure: Schema.optional(RunFailure),
  finishedAt: Instant,
  flow: Flow,
  flowHash: nonEmptyString,
  /**
   * The Flow's stable identity. Falls back to the Flow's content hash when the
   * Flow declares none, so Run history is never keyed on the editable title.
   */
  flowId: nonEmptyString,
  outcome: RunOutcome,
  runId: nonEmptyString,
  startedAt: Instant,
  steps: Schema.Array(RunStep),
  /** Whether this invocation kept its default Playwright Trace artifact. */
  trace: Schema.Boolean,
  /**
   * Whether this invocation asked for a video derived from the Trace. The
   * browser is never paced or captured live to produce it (ADR 0014).
   */
  video: Schema.Boolean,
});
export type Run = typeof Run.Type;

/** A Run whose Steps failed is never eligible to anchor a comparison. */
export const runIsBaselineEligible = (run: Run): boolean =>
  run.outcome === "completed";

/**
 * The warning a Baseline comparison must carry when the two Runs were audited
 * by different engine versions, or `undefined` when there is nothing to warn
 * about. It warns rather than refuses (ADR 0017): rule churn between versions
 * describes the engine, not the site, and refusing would discard exactly the
 * history that makes a Baseline worth keeping.
 *
 * Absent versions warn nothing: a Run without an Audit Step recorded no
 * engine, and it also has no Findings for the comparison to misattribute.
 */
export const axeVersionMismatchWarning = (
  baseline: RunEnvironment,
  current: RunEnvironment
): string | undefined => {
  const before = baseline.axeVersion;
  const after = current.axeVersion;
  if (before === undefined || after === undefined || before === after) {
    return undefined;
  }
  return `The Baseline was audited by axe-core ${before}, this Run by ${after}. Differences in Findings may describe the engine upgrade rather than the site.`;
};
