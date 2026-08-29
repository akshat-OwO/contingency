import { Schema } from "effect";

import { Flow, Gate } from "./flow.ts";

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

/** Evidence a bounded Scroll readiness wait could not establish in time. */
export const ScrollReadinessEvidence = Schema.Literals([
  "dom-mutations",
  "finite-requests",
  "observation-ended",
  "scroll-position",
]);
export type ScrollReadinessEvidence = typeof ScrollReadinessEvidence.Type;

/**
 * A Scroll still succeeded, but the Runner reached its readiness bound before
 * the page settled. This is observation metadata, not a Finding or failure.
 */
export const ScrollReadinessDiagnostic = Schema.Struct({
  pendingRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unsettled: Schema.Array(ScrollReadinessEvidence).check(Schema.isMinLength(1)),
  waitDurationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScrollReadinessDiagnostic = typeof ScrollReadinessDiagnostic.Type;

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
  /** Present only when a Scroll Pre-step exhausted its readiness bound. */
  scrollReadiness: Schema.optional(ScrollReadinessDiagnostic),
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

/** One sampled element that a rule failed on. */
export const FindingNode = Schema.Struct({
  /** The engine's explanation for why this element failed the rule. */
  message: nonEmptyString,
  /**
   * How to find the element. Frame hops use ` >>> ` and shadow-root hops use
   * ` >> `, matching the browser tooling's piercing-selector notation.
   */
  target: nonEmptyString,
});
export type FindingNode = typeof FindingNode.Type;

/**
 * One accessibility rule violation found by one Audit Step.
 *
 * `nodeCount` is the engine's true count and `nodes` is Contingency's bounded
 * sample of places to start. A rule failing on four hundred elements therefore
 * produces one Finding rather than four hundred indistinguishable records.
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
  /** How many elements the engine says failed this rule. */
  nodeCount: Schema.Int,
  /** A bounded sample of elements that failed this rule. */
  nodes: Schema.Array(FindingNode),
  /** The engine's rule id, e.g. `image-alt`. */
  rule: nonEmptyString,
  severity: FindingSeverity,
  /** Position of the Audit Step that produced it, in executed Flow order. */
  stepIndex: Schema.Int,
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
  /** Present only when a Scroll exhausted its readiness bound. */
  scrollReadiness: Schema.optional(ScrollReadinessDiagnostic),
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
 * Why the Page did not go quiet before the Run's bounded wait ended (ADR
 * 0015). Absent when the wait proved settlement. This is not a Finding, cannot
 * breach a Gate, and does not change the attempt's outcome.
 */
export const SettlingDiagnostic = Schema.Struct({
  /**
   * What was still busy when the bound expired, in the order the wait looked
   * for it.
   */
  remaining: Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
  waitMs: Schema.Int,
});
export type SettlingDiagnostic = typeof SettlingDiagnostic.Type;

/**
 * Record a settling diagnostic only when evidence remained. An empty remaining
 * list is a successful wait, not a document of nothing.
 */
export const settlingDiagnostic = (
  waitMs: number,
  remaining: readonly string[]
): SettlingDiagnostic | undefined => {
  if (remaining.length === 0) {
    return undefined;
  }
  return {
    remaining: [...remaining],
    waitMs: Math.max(0, Math.round(waitMs)),
  };
};

/** The diagnostic as a sentence for Audit View's Run settled pane. */
export const describeSettlingDiagnostic = (
  diagnostic: SettlingDiagnostic
): string =>
  `Waited ${String(diagnostic.waitMs)}ms; ${diagnostic.remaining.join(" and ")} still prevented settlement.`;

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
  /**
   * Present when the final quiet wait hit its bound before the Page settled.
   * Selecting `Run settled` shows this instead of inventing another Step
   * (ADR 0014).
   */
  settling: Schema.optional(SettlingDiagnostic),
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
 * Where the Gate this Run was held to came from. A Gate is a fact about what
 * is being audited rather than about how the Run was invoked ([ADR
 * 0018](../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)), so
 * it lives in the Flow — but an invocation may tighten or relax the bar
 * without editing the Flow, and a reader of the Run must be able to tell which
 * bar was actually applied.
 */
export const RunGateSource = Schema.Literals(["flow", "invocation"]);
export type RunGateSource = typeof RunGateSource.Type;

/**
 * The Gate a Run was held to, and the rules it breached.
 *
 * Recorded whether or not anything breached: a Run that names its bar and met
 * it is different evidence from a Run that was held to no bar at all, and a
 * later comparison cannot recover the difference from an absent field.
 *
 * A breach never changes {@link Run.outcome}. It changes the CLI's exit code
 * and nothing else, so a Run documenting today's known-bad state stays
 * eligible as a Baseline — see {@link runIsBaselineEligible}.
 */
export const RunGate = Schema.Struct({
  /**
   * The Gate rules that produced at least one Finding, in Gate order. Empty
   * when the Run met its bar.
   */
  breached: Schema.Array(nonEmptyString),
  /** The rule ids actually applied, after any invocation override. */
  rules: Gate,
  source: RunGateSource,
});
export type RunGate = typeof RunGate.Type;

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
  /**
   * The Gate this Run was held to. Absent when the Flow declared none and the
   * invocation supplied none, which is the default: a Run then reports every
   * violation and fails nothing (ADR 0009).
   */
  gate: Schema.optional(RunGate),
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

/**
 * A Run whose Steps failed is never eligible to anchor a comparison.
 *
 * Deliberately keyed on outcome alone. A Gate breach is the site missing a bar
 * the author chose, not the Run failing, and the Runs most worth comparing
 * against tomorrow are exactly the ones documenting today's known-bad state
 * (ADR 0018). Folding a breach in here would discard them.
 */
export const runIsBaselineEligible = (run: Run): boolean =>
  run.outcome === "completed";

/**
 * Which of `rules` at least one of `findings` was raised against, in the
 * Gate's own order so the record reads as the author wrote the bar.
 */
export const gateBreaches = (
  rules: Gate,
  findings: readonly Pick<Finding, "rule">[]
): readonly string[] => {
  const raised = new Set(findings.map(({ rule }) => rule));
  return rules.filter((rule) => raised.has(rule));
};

/** Whether this Run was held to a Gate and missed it. */
export const runBreachedGate = (run: Run): boolean =>
  (run.gate?.breached.length ?? 0) > 0;

/**
 * What the CLI exits with. Outcome and exit code are separate axes (ADR 0018):
 * `0` completed and within its Gate, `1` the Run did not complete, `2` the Run
 * completed and breached its Gate. One code cannot express the difference
 * between a regressed site and a broken check, and CI needs to tell them
 * apart.
 *
 * A Run that did not complete reports `1` even where its Findings would have
 * breached, because a Run that stopped early has not established that the
 * Gate's other rules pass.
 */
export const runExitCode = (run: Run): 0 | 1 | 2 => {
  if (run.outcome !== "completed") {
    return 1;
  }
  return runBreachedGate(run) ? 2 : 0;
};

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

// ---------------------------------------------------------------------------
// Observing a Run
// ---------------------------------------------------------------------------

/**
 * Where a Run watched from Audit View has got to.
 *
 * `starting` covers everything between the request and the first Step —
 * resolving Variables, installing and launching Chromium — which is long
 * enough that collapsing it into `running` would show an empty timeline with
 * no explanation. `finished` means the Run is written and its artifacts are
 * prepared, which is the first moment any frame exists to show
 * ([ADR 0023](../../../docs/adr/0023-audit-view-starts-runs.md)).
 */
export const RunPhase = Schema.Literals([
  "idle",
  "starting",
  "running",
  "finished",
]);
export type RunPhase = typeof RunPhase.Type;

/**
 * A `runtime` Variable the Runner is waiting on. A web server is never an
 * interactive terminal, so the prompt seam is answered by the browser rather
 * than by stdin (ADR 0023). The value never travels back in a snapshot: only
 * the question does.
 */
export const RunVariablePrompt = Schema.Struct({
  name: nonEmptyString,
  /**
   * A Variable that is both secret and runtime is usually a single-use code,
   * which no retry can reuse. The interface says so where it is asked.
   */
  secret: Schema.Boolean,
});
export type RunVariablePrompt = typeof RunVariablePrompt.Type;

/**
 * Everything Audit View knows about the one Flow this process was opened on.
 *
 * The Flow travels whatever the phase, so the Step timeline reads before a Run
 * has ever started. {@link RunSnapshot.steps} is the attempt in flight and is
 * replaced wholesale by each fresh attempt, never appended to: attempts are
 * context-isolated and are not one timeline (ADR 0015). Once `phase` is
 * `finished`, {@link RunSnapshot.run} carries every attempt and `steps` stops
 * being the interesting reading.
 *
 * The artifact manifests ride along rather than being fetched separately: they
 * are small, they only ever change with the phase, and a second round trip
 * could show a player before the manifest that explains it arrived.
 */
export const RunSnapshot = Schema.Struct({
  /** The attempt in flight, 1-based. Absent before the first one begins. */
  attempt: Schema.optional(Schema.Int),
  /** How many attempts this Run may make at most, retries included. */
  attemptCeiling: Schema.Int,
  /**
   * Why the Run could not start, or could not be persisted. A Run that
   * executed and failed is not this: that is a `finished` Run whose outcome is
   * `failed`.
   */
  error: Schema.optional(nonEmptyString),
  flow: Flow,
  outcome: Schema.optional(RunOutcome),
  phase: RunPhase,
  /** The finished Run, with every attempt. Null until the Run ends. */
  run: Schema.NullOr(Run),
  /** Index of the Step executing right now, absent between Steps. */
  runningIndex: Schema.optional(Schema.Int),
  /** The current attempt's Steps so far, in executed order. */
  steps: Schema.Array(RunStep),
  trace: Schema.NullOr(RunTraceManifest),
  /** The `runtime` Variable the Runner is blocked on, if any. */
  variablePrompt: Schema.NullOr(RunVariablePrompt),
  video: Schema.NullOr(RunVideoManifest),
  /** Preflight's warnings, shown once rather than swallowed. */
  warnings: Schema.Array(nonEmptyString),
});
export type RunSnapshot = typeof RunSnapshot.Type;

/**
 * Whether a Run is in flight, and so cannot be started again. Both sides
 * answer with this predicate rather than with two bodies that agree by
 * coincidence.
 */
export const runIsInFlight = (snapshot: RunSnapshot | null): boolean =>
  snapshot?.phase === "starting" || snapshot?.phase === "running";

/**
 * Which attempt Audit View opens on: the last one that failed, falling back to
 * the last recorded. The attempt worth watching is the one that went wrong,
 * and on a Run that needed no retry both answers are the same.
 */
export const defaultAttempt = (run: Run): number => {
  const failed = run.attempts.findLast(
    (attempt) => attempt.outcome === "failed"
  );
  return (failed ?? run.attempts.at(-1))?.attempt ?? 1;
};

/**
 * Where one attempt's derived video is served from.
 *
 * The protocol owns the shape because both sides need the same one: the CLI
 * routes it and Audit View requests it. Video bytes deliberately do not travel
 * over RPC — a WebM is megabytes of binary that would be framed and buffered
 * through the same socket the Run's progress arrives on, where a plain HTTP
 * resource is streamed, seeked, and cached by the browser's own media element.
 */
export const runVideoPath = (runId: string, attempt: number): string =>
  `/runs/${encodeURIComponent(runId)}/video/${attempt}`;

/**
 * How long each derived frame is held in an attempt's video.
 *
 * The protocol owns it because both sides need the same number: the CLI
 * encodes at this rate, and Audit View seeks by it. Two constants that agreed
 * by coincidence would drift a seek onto the wrong Step.
 */
export const VIDEO_FRAME_DURATION_SECONDS = 0.5;

/**
 * Which frame a playhead sits on. The settled-state frame is a terminal of
 * the Run, not another Step, so it is a distinct kind (ADR 0014).
 */
export type VideoFrameTarget =
  | { readonly kind: "settled" }
  | { readonly kind: "step"; readonly index: number };

/**
 * Where in an attempt's derived video a Step's frame sits, in seconds, or
 * `undefined` when that Step is not among the frames the segment recorded.
 *
 * Derivation lays one frame per executed Step in order, each held for the same
 * duration, then appends the settled-state frame. Seeking is therefore
 * arithmetic on the segment's own `steps` list rather than a second index that
 * could disagree with it. The first executed Step begins at `0:00.0`; every
 * later Step seeks to the beginning of its frame.
 */
export const stepFrameSeconds = (
  segment: RunVideoSegment,
  stepIndex: number,
  frameDurationSeconds: number = VIDEO_FRAME_DURATION_SECONDS
): number | undefined => {
  const position = segment.steps.indexOf(stepIndex);
  return position === -1 ? undefined : position * frameDurationSeconds;
};

/**
 * Where the settled-state frame begins, or `undefined` when capture produced
 * none. That absence must stay visible: the final Step is never reused as the
 * settled interval (ADR 0014).
 */
export const settledFrameSeconds = (
  segment: RunVideoSegment,
  frameDurationSeconds: number = VIDEO_FRAME_DURATION_SECONDS
): number | undefined =>
  segment.includesSettledState
    ? segment.steps.length * frameDurationSeconds
    : undefined;

/**
 * How long the segment plays: one frame per executed Step, plus the settled
 * state when the Trace caught it.
 */
export const videoSegmentDuration = (
  segment: RunVideoSegment,
  frameDurationSeconds: number = VIDEO_FRAME_DURATION_SECONDS
): number =>
  (segment.steps.length + (segment.includesSettledState ? 1 : 0)) *
  frameDurationSeconds;

/**
 * Which frame owns a playhead time. Inverse of {@link stepFrameSeconds} and
 * {@link settledFrameSeconds}. A time at the declared duration still belongs
 * to the last complete interval, so the media element's end does not invent a
 * frame past the segment.
 */
export const playheadAtSeconds = (
  segment: RunVideoSegment,
  seconds: number,
  frameDurationSeconds: number = VIDEO_FRAME_DURATION_SECONDS
): VideoFrameTarget | undefined => {
  const duration = videoSegmentDuration(segment, frameDurationSeconds);
  if (duration === 0 || !Number.isFinite(seconds)) {
    return undefined;
  }
  const last = duration / frameDurationSeconds - 1;
  const raw = seconds <= 0 ? 0 : Math.floor(seconds / frameDurationSeconds);
  const position = Math.min(raw, last);
  if (position >= segment.steps.length) {
    return segment.includesSettledState ? { kind: "settled" } : undefined;
  }
  const index = segment.steps[position];
  return index === undefined ? undefined : { index, kind: "step" };
};
