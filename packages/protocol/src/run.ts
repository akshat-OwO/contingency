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
 * One executed Step, recorded whether it succeeded or not. `index` is the
 * Step's position in the executed Flow, so a Run reads against its own
 * embedded Flow without a separate lookup.
 */
export const RunStep = Schema.Struct({
  error: Schema.optional(Schema.String),
  /** Everything an Audit Step found. Absent on Steps that audit nothing. */
  findings: Schema.optional(Schema.Array(Finding)),
  finishedAt: Instant,
  index: Schema.Int,
  outcome: RunStepOutcome,
  /** Every Pre-step evaluated before this Step, in evaluation order. */
  preSteps: Schema.optional(Schema.Array(RunPreStep)),
  startedAt: Instant,
  stepId: Schema.optional(Schema.String),
  type: nonEmptyString,
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
});
export type Run = typeof Run.Type;

/** A Run whose Steps failed is never eligible to anchor a comparison. */
export const runIsBaselineEligible = (run: Run): boolean =>
  run.outcome === "completed";
