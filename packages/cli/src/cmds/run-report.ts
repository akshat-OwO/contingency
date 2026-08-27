import path from "node:path";

import type { Run, RunVideoManifest } from "@contingency/protocol";
import { Effect, FileSystem } from "effect";

/**
 * What the terminal says about a finished Run, beyond its outcome and where it
 * was written.
 *
 * Each of these answers one question and returns the line to print, or
 * `undefined` when there is nothing to say. They live apart from the command
 * so that reading `run` shows the shape of an invocation — decode, preflight,
 * execute, report, exit — rather than the wording of every warning.
 */

/** What the Flow asked for and the Run resolved it to, said once. */
export const gateOverrideWarning = (
  gate: readonly string[],
  ignoreGate: boolean
): string | undefined =>
  ignoreGate && gate.length > 0
    ? "Warning: --ignore-gate was given alongside --gate, so this Run is held to no Gate."
    : undefined;

/**
 * The rule ids this invocation holds the Run to, or `undefined` to leave the
 * Flow's own Gate alone.
 *
 * A Gate is a fact about what is being audited, so it lives in the Flow; an
 * invocation may still tighten or relax the bar without editing the Flow ([ADR
 * 0018](../../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)).
 * `--ignore-gate` resolves to an empty list, which is a deliberate override
 * holding the Run to nothing rather than an absent one.
 */
export const gateOverride = (
  gate: readonly string[],
  ignoreGate: boolean
): readonly string[] | undefined => {
  if (ignoreGate) {
    return [];
  }
  return gate.length > 0 ? gate : undefined;
};

/**
 * How many accessibility Findings a Run holds, and how many more the engine
 * counted but did not list.
 *
 * Reported, never fatal by count: every real site has pre-existing violations,
 * so failing on their number makes the check red on day one (ADR 0009). Only a
 * Gate an author opted into changes the exit code.
 */
export const findingsSummary = (run: Run): string | undefined => {
  const findings = run.steps.reduce(
    (total, step) => total + (step.findings?.length ?? 0),
    0
  );
  if (findings === 0) {
    return undefined;
  }
  // The Runner lists at most ten elements per rule while counting them all, so
  // the Findings can be fewer than the page has (ADR 0017).
  const elided = run.steps.reduce(
    (total, step) =>
      total +
      (step.elidedFindings ?? []).reduce(
        (missing, rule) => missing + (rule.total - rule.reported),
        0
      ),
    0
  );
  const counted =
    elided === 0
      ? ""
      : `, and ${elided} more the accessibility engine counted but did not list`;
  return `${findings} accessibility ${findings === 1 ? "Finding" : "Findings"}${counted}.`;
};

/**
 * How many Steps asked for Core Web Vitals and carry none. A Step the Flow
 * asked to measure that was not measured has to say so, or a Run silently
 * reports performance for some navigations and not others.
 */
export const unmeasuredWarning = (run: Run): string | undefined => {
  const unmeasured = run.steps.filter((step) => {
    // Keyed on the Step's own recorded index rather than its position here,
    // which are the same only while no Step is ever left out.
    const source = run.flow.steps[step.index];
    return (
      source?.performance === true &&
      step.outcome === "completed" &&
      step.vitals === undefined
    );
  }).length;
  return unmeasured === 0
    ? undefined
    : `Warning: ${unmeasured} ${unmeasured === 1 ? "Step" : "Steps"} asked for Core Web Vitals but could not be measured.`;
};

/**
 * How to say that a requested derived video could not be written. Artifact
 * failure does not change the Run outcome, but it must not pass silently.
 */
export const videoWarning = Effect.fn("run.videoWarning")(
  function* videoWarning(run: Run, directory: string) {
    if (!run.video) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const read = yield* Effect.result(
      fileSystem.readFileString(path.join(directory, "video.json"))
    );
    if (read._tag === "Failure") {
      return;
    }
    const manifest = JSON.parse(read.success) as RunVideoManifest;
    const missing = manifest.segments
      .filter(({ recorded }) => !recorded)
      .map(
        ({ attempt, error }) =>
          `attempt ${attempt} (${error ?? "no reason given"})`
      );
    return missing.length === 0
      ? undefined
      : `Warning: video was requested but ${missing.length} ${missing.length === 1 ? "attempt" : "attempts"} produced no recording: ${missing.join("; ")}`;
  }
);
