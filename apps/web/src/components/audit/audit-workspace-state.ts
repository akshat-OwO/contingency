import type {
  Finding,
  RunAttempt,
  RunSnapshot,
  RunStep,
  RunTraceSegment,
  RunVideoSegment,
  VideoFrameTarget,
} from "@contingency/protocol";
import {
  defaultAttempt,
  settledFrameSeconds,
  stepFrameSeconds,
  videoSegmentDuration,
} from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

import { describeStep } from "@/lib/flow-labels";

/**
 * Where one Step of the timeline has got to. `pending` is a Step the Runner
 * has not reached, which reads differently from one that ran and passed.
 */
export type StepState = "done" | "pending" | "running";

export interface TimelineStep {
  readonly findings: readonly Finding[];
  readonly index: number;
  readonly label: string;
  /** The Step's own record, once it has one. */
  readonly result: RunStep | undefined;
  readonly state: StepState;
  readonly type: string;
}

export interface AuditWorkspaceState {
  /**
   * The attempt the reader chose, or `undefined` to follow the Run's own
   * default — the last failed attempt. Attempts are never concatenated into
   * one timeline: each is a fresh context.
   */
  readonly attempt: number | undefined;
  /**
   * The frame the reader pinned, or `undefined` to follow the Runner. A click
   * pins; nothing else does. Settled is a pin of its own, never a Step index.
   */
  readonly pin: VideoFrameTarget | undefined;
  readonly run: RunSnapshot | null;
}

export const auditWorkspaceAtom = Atom.make<AuditWorkspaceState>({
  attempt: undefined,
  pin: undefined,
  run: null,
});

export const auditStreamErrorAtom = Atom.make<string | null>(null);

/** The value typed into the runtime-Variable prompt, before it is answered. */
export const auditVariableDraftAtom = Atom.make<string>("");

export const auditBusyAtom = Atom.make<boolean>(false);

/**
 * Why the last thing the reader asked for was refused — a Run started while a
 * Recording holds the browser, most often. Distinct from a Run that started
 * and then failed, which is a `finished` Run with a `failed` outcome.
 */
export const auditActionErrorAtom = Atom.make<string | null>(null);

/** The attempt on show: the reader's choice, else the Run's own default. */
export const selectedAttempt = (
  snapshot: RunSnapshot | null,
  chosen: number | undefined
): number | undefined => {
  if (snapshot === null) {
    return undefined;
  }
  if (chosen !== undefined) {
    return chosen;
  }
  return snapshot.run === null
    ? snapshot.attempt
    : defaultAttempt(snapshot.run);
};

export const attempts = (snapshot: RunSnapshot | null): readonly RunAttempt[] =>
  snapshot?.run?.attempts ?? [];

/**
 * The Steps to show: a finished Run reads off the chosen attempt, and a Run in
 * flight reads off the attempt the Runner is executing, which is the only one
 * that exists yet.
 */
export const attemptSteps = (
  snapshot: RunSnapshot | null,
  attempt: number | undefined
): readonly RunStep[] => {
  if (snapshot === null) {
    return [];
  }
  if (snapshot.run === null) {
    return snapshot.steps;
  }
  return (
    snapshot.run.attempts.find((candidate) => candidate.attempt === attempt)
      ?.steps ?? snapshot.run.steps
  );
};

/**
 * Every Step the Flow declares, married to whatever the Run has recorded for
 * it. The Flow leads rather than the results, so the timeline has its full
 * length before the first Step runs.
 */
export const timelineSteps = (
  snapshot: RunSnapshot | null,
  attempt: number | undefined
): readonly TimelineStep[] => {
  if (snapshot === null) {
    return [];
  }
  const results = attemptSteps(snapshot, attempt);
  const byIndex = new Map(results.map((step) => [step.index, step]));
  // Only the attempt in flight has a running Step. A finished attempt the
  // reader has scrolled back to is entirely done.
  const running =
    snapshot.phase === "running" &&
    (snapshot.run === null || attempt === snapshot.attempt)
      ? snapshot.runningIndex
      : undefined;
  return snapshot.flow.steps.map((step, index) => {
    const result = byIndex.get(index);
    let state: StepState = "pending";
    if (result !== undefined) {
      state = "done";
    } else if (index === running) {
      state = "running";
    }
    return {
      findings: result?.findings ?? [],
      index,
      label: describeStep(step),
      result,
      state,
      type: step.type,
    };
  });
};

/**
 * Which Step is on show. Auto-follow tracks the Runner until a click pins one;
 * a finished Run opens on the Step that failed, which is what a reader came
 * for, and on the first Step when nothing did — a Run that passed is read
 * forwards, from the beginning, not from where the Runner happened to stop.
 */
export const selectedStepIndex = (
  timeline: readonly TimelineStep[],
  snapshot: RunSnapshot | null,
  pinned: number | undefined
): number | undefined => {
  if (timeline.length === 0) {
    return undefined;
  }
  if (pinned !== undefined && timeline.some(({ index }) => index === pinned)) {
    return pinned;
  }
  if (snapshot?.phase === "running") {
    const running = timeline.findLast(({ state }) => state !== "pending");
    return running?.index ?? timeline[0]?.index;
  }
  const failed = timeline.find(
    ({ result }) => result?.outcome === "failed"
  )?.index;
  return failed ?? timeline.find(({ result }) => result !== undefined)?.index;
};

/**
 * Which frame is on show. A settled pin wins only while that attempt actually
 * has a settled-state frame; otherwise the ordinary Step selection applies.
 */
export const selectedFrame = (
  timeline: readonly TimelineStep[],
  snapshot: RunSnapshot | null,
  pin: VideoFrameTarget | undefined,
  segment: RunVideoSegment | undefined
): VideoFrameTarget | undefined => {
  if (pin?.kind === "settled" && segment?.includesSettledState === true) {
    return { kind: "settled" };
  }
  const index = selectedStepIndex(
    timeline,
    snapshot,
    pin?.kind === "step" ? pin.index : undefined
  );
  return index === undefined ? undefined : { index, kind: "step" };
};

export const videoSegment = (
  snapshot: RunSnapshot | null,
  attempt: number | undefined
): RunVideoSegment | undefined =>
  snapshot?.video?.segments.find((segment) => segment.attempt === attempt);

export const traceSegment = (
  snapshot: RunSnapshot | null,
  attempt: number | undefined
): RunTraceSegment | undefined =>
  snapshot?.trace?.segments.find((segment) => segment.attempt === attempt);

/**
 * Where the player should sit for the selected frame, or `undefined` when the
 * segment holds no frame for it — a Step of an attempt that failed before
 * reaching it, or a settled pin when capture produced none.
 */
export const seekSeconds = (
  segment: RunVideoSegment | undefined,
  target: VideoFrameTarget | undefined
): number | undefined => {
  if (segment === undefined || target === undefined) {
    return undefined;
  }
  return target.kind === "settled"
    ? settledFrameSeconds(segment)
    : stepFrameSeconds(segment, target.index);
};

/**
 * A playhead position as `m:ss.d`. Tenths, because a frame is half a second:
 * whole seconds would show two Steps at the same time.
 */
export const formatTimecode = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
};

/**
 * How long the segment plays: one frame per executed Step, plus the settled
 * state derivation appends after them when the Trace caught it. Counting that
 * last frame keeps the transport's numbers honest — without it the timecode
 * reads past its own total.
 */
export const segmentDuration = (
  segment: RunVideoSegment | undefined
): number => (segment === undefined ? 0 : videoSegmentDuration(segment));

/** How many Steps the Run has finished. */
export const stepsDone = (timeline: readonly TimelineStep[]): number =>
  timeline.filter(({ state }) => state === "done").length;

/** How far through the Flow the Run has got, as a fraction. */
export const runProgress = (timeline: readonly TimelineStep[]): number =>
  timeline.length === 0 ? 0 : stepsDone(timeline) / timeline.length;

/**
 * The Gate breach, when there is one. Kept apart from the outcome deliberately:
 * a breach is a verdict on the site, and a breaching Run is still a completed
 * Run and still Baseline-eligible
 * ([ADR 0018](../../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)).
 */
export const gateBreach = (
  snapshot: RunSnapshot | null
): readonly string[] | undefined => {
  const breached = snapshot?.run?.gate?.breached ?? [];
  return breached.length === 0 ? undefined : breached;
};
