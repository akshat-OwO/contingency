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
 * One executed Step, recorded whether it succeeded or not. `index` is the
 * Step's position in the executed Flow, so a Run reads against its own
 * embedded Flow without a separate lookup.
 */
export const RunStep = Schema.Struct({
  error: Schema.optional(Schema.String),
  finishedAt: Instant,
  index: Schema.Int,
  outcome: RunStepOutcome,
  startedAt: Instant,
  stepId: Schema.optional(Schema.String),
  type: nonEmptyString,
});
export type RunStep = typeof RunStep.Type;

/**
 * Why a Run did not complete. Failure classification (`siteError` against
 * `flowError`) arrives with retry, so this carries only the message and the
 * Step that produced it for now.
 */
export const RunFailure = Schema.Struct({
  message: nonEmptyString,
  stepIndex: Schema.optional(Schema.Int),
});
export type RunFailure = typeof RunFailure.Type;

/**
 * One execution of a Flow. Self-contained: it embeds the Flow it executed plus
 * that Flow's content hash, so a Run stays interpretable when it travels
 * without its Flow file, and so a later Baseline comparison can cheaply detect
 * that the Flow changed underneath it (ADR 0009).
 */
export const Run = Schema.Struct({
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
