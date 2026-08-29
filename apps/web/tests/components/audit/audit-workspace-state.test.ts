import type { RunSnapshot, RunStep } from "@contingency/protocol";
import { playheadAtSeconds } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  attempts,
  attemptSteps,
  formatTimecode,
  gateBreach,
  seekSeconds,
  selectedAttempt,
  selectedFrame,
  selectedStepIndex,
  segmentDuration,
  timelineSteps,
  videoSegment,
} from "@/components/audit/audit-workspace-state";
import { describeStep } from "@/lib/flow-labels";

const stepAt = (index: number, outcome: "completed" | "failed"): RunStep => ({
  finishedAt: "2026-01-01T00:00:01.000Z",
  index,
  outcome,
  startedAt: "2026-01-01T00:00:00.000Z",
  type: "click",
});

/** Neither an attempt nor a Step chosen: the interface follows the Runner. */
const following: number | undefined = undefined;

const snapshot = (overrides: Partial<RunSnapshot>): RunSnapshot =>
  ({
    attemptCeiling: 4,
    flow: {
      steps: [
        { type: "navigate", url: "https://example.com/cart" },
        {
          target: [{ kind: "role", name: "Pay", role: "button" }],
          type: "click",
        },
        { kind: "accessibility", type: "audit" },
      ],
      title: "Checkout",
    },
    phase: "idle",
    run: null,
    steps: [],
    trace: null,
    variablePrompt: null,
    video: null,
    warnings: [],
    ...overrides,
  }) as RunSnapshot;

describe("the timeline", () => {
  it("has its full length before the first Step runs", () => {
    const timeline = timelineSteps(snapshot({}), following);
    expect(timeline).toHaveLength(3);
    expect(timeline.map(({ state }) => state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    // A reader scanning a Flow with several clicks needs to tell them apart.
    expect(timeline[1]?.label).toBe('Click button "Pay"');
  });

  it("marks the Step the Runner is on as running and the rest as pending", () => {
    const timeline = timelineSteps(
      snapshot({
        phase: "running",
        runningIndex: 1,
        steps: [stepAt(0, "completed")],
      }),
      following
    );
    expect(timeline.map(({ state }) => state)).toEqual([
      "done",
      "running",
      "pending",
    ]);
  });

  it("shows no Step as running on an attempt the reader scrolled back to", () => {
    const timeline = timelineSteps(
      snapshot({
        attempt: 2,
        phase: "running",
        run: {
          attempts: [
            { attempt: 1, outcome: "failed", steps: [stepAt(0, "failed")] },
          ],
          runId: "run-1",
          steps: [],
        },
        runningIndex: 1,
      } as unknown as Partial<RunSnapshot>),
      1
    );
    expect(timeline.map(({ state }) => state)).toEqual([
      "done",
      "pending",
      "pending",
    ]);
  });
});

describe("what is selected", () => {
  it("follows the Runner until a click pins a Step", () => {
    const live = snapshot({
      phase: "running",
      runningIndex: 1,
      steps: [stepAt(0, "completed")],
    });
    const timeline = timelineSteps(live, following);
    expect(selectedStepIndex(timeline, live, following)).toBe(1);
    expect(selectedStepIndex(timeline, live, 0)).toBe(0);
  });

  it("opens a finished Run on the Step that failed", () => {
    const steps = [stepAt(0, "completed"), stepAt(1, "failed")];
    const finished = snapshot({
      phase: "finished",
      run: { attempts: [], runId: "run-1", steps } as unknown as never,
      steps,
    });
    const timeline = timelineSteps(finished, following);
    expect(selectedStepIndex(timeline, finished, following)).toBe(1);
  });

  it("opens a Run that passed on its first Step, not its last", () => {
    const steps = [stepAt(0, "completed"), stepAt(1, "completed")];
    const finished = snapshot({
      phase: "finished",
      run: { attempts: [], runId: "run-1", steps } as unknown as never,
      steps,
    });
    const timeline = timelineSteps(finished, following);
    // A Run that passed is read forwards, from the beginning, rather than from
    // wherever the Runner happened to stop.
    expect(selectedStepIndex(timeline, finished, following)).toBe(0);
  });

  it("keeps Run settled as its own selection, never a Step", () => {
    const steps = [stepAt(0, "completed"), stepAt(1, "completed")];
    const finished = snapshot({
      phase: "finished",
      steps,
      video: {
        containsSecrets: false,
        runId: "run-1",
        segments: [
          {
            attempt: 1,
            file: "attempt-1.webm",
            includesSettledState: true,
            recorded: true,
            steps: [0, 1],
          },
        ],
      },
    });
    const timeline = timelineSteps(finished, following);
    const segment = videoSegment(finished, 1);
    expect(
      selectedFrame(timeline, finished, { kind: "settled" }, segment)
    ).toEqual({ kind: "settled" });
    expect(
      selectedFrame(
        timeline,
        finished,
        { kind: "settled" },
        {
          attempt: 1,
          error: "The Trace did not capture the final settled state.",
          file: "attempt-1.webm",
          includesSettledState: false,
          recorded: false,
          steps: [],
        }
      )?.kind
    ).toBe("step");
  });
});

describe("attempts", () => {
  const retried = snapshot({
    phase: "finished",
    run: {
      attempts: [
        { attempt: 1, outcome: "failed", steps: [stepAt(0, "failed")] },
        {
          attempt: 2,
          outcome: "completed",
          steps: [stepAt(0, "completed"), stepAt(1, "completed")],
        },
      ],
      runId: "run-1",
      steps: [stepAt(0, "completed"), stepAt(1, "completed")],
    } as unknown as never,
    steps: [],
  });

  it("defaults to the last failed attempt", () => {
    expect(selectedAttempt(retried, following)).toBe(1);
    expect(selectedAttempt(retried, 2)).toBe(2);
  });

  it("lists the one attempt a Run that needed no retry made", () => {
    const single = snapshot({
      phase: "finished",
      run: {
        attempts: [{ attempt: 1, outcome: "completed", steps: [] }],
        runId: "run-1",
        steps: [],
      } as unknown as never,
    });
    expect(attempts(single)).toHaveLength(1);
    expect(selectedAttempt(single, following)).toBe(1);
  });

  it("never concatenates two attempts into one timeline", () => {
    expect(attemptSteps(retried, 1)).toHaveLength(1);
    expect(attemptSteps(retried, 2)).toHaveLength(2);
  });
});

describe("frames", () => {
  const withVideo = snapshot({
    phase: "finished",
    video: {
      containsSecrets: false,
      runId: "run-1",
      segments: [
        {
          attempt: 1,
          error: "The Trace did not capture a frame for every Step.",
          file: "attempt-1.webm",
          includesSettledState: false,
          recorded: false,
          steps: [],
        },
        {
          attempt: 2,
          file: "attempt-2.webm",
          includesSettledState: true,
          recorded: true,
          steps: [0, 1, 2],
        },
      ],
    },
  });

  it("keeps an attempt that recorded no video separable from one that did", () => {
    expect(videoSegment(withVideo, 1)?.recorded).toBe(false);
    expect(videoSegment(withVideo, 1)?.error).toContain("did not capture");
    expect(videoSegment(withVideo, 2)?.recorded).toBe(true);
  });

  it("names the Step the playhead is over, wherever it was scrubbed to", () => {
    const segment = videoSegment(withVideo, 2);
    expect(segment).toBeDefined();
    if (segment === undefined) {
      return;
    }
    // Frames are laid one per executed Step, in order, at a fixed duration,
    // so the inverse of a Step's seek is arithmetic on the same list.
    expect(playheadAtSeconds(segment, 0)).toEqual({ index: 0, kind: "step" });
    expect(playheadAtSeconds(segment, 0.5)).toEqual({ index: 1, kind: "step" });
    expect(playheadAtSeconds(segment, 1)).toEqual({ index: 2, kind: "step" });
    // Past the Step frames is the settled state, which belongs to no Step.
    expect(playheadAtSeconds(segment, 1.5)).toEqual({ kind: "settled" });
    expect(playheadAtSeconds(segment, 2)).toEqual({ kind: "settled" });
    expect(playheadAtSeconds(segment, 99)).toEqual({ kind: "settled" });
    expect(playheadAtSeconds(segment, 1.4)).toEqual({ index: 2, kind: "step" });
    const missing = videoSegment(withVideo, 1);
    expect(missing).toBeDefined();
    if (missing === undefined) {
      return;
    }
    expect(playheadAtSeconds(missing, 0)).toBeUndefined();
  });

  it("counts the settled frame derivation appends after the Steps", () => {
    // Three Step frames plus the settled one: a duration that stopped at the
    // Steps would read past its own total on the last frame.
    expect(segmentDuration(videoSegment(withVideo, 2))).toBe(2);
    expect(segmentDuration(videoSegment(withVideo, 1))).toBe(0);
  });

  it("seeks a Step to the beginning of its frame, starting at 0:00.0", () => {
    const segment = videoSegment(withVideo, 2);
    expect(seekSeconds(segment, { index: 0, kind: "step" })).toBe(0);
    expect(seekSeconds(segment, { index: 1, kind: "step" })).toBe(0.5);
    expect(seekSeconds(segment, { index: 2, kind: "step" })).toBe(1);
    expect(seekSeconds(segment, { kind: "settled" })).toBe(1.5);
    expect(seekSeconds(segment, following)).toBeUndefined();
    expect(
      seekSeconds(videoSegment(withVideo, 1), { index: 0, kind: "step" })
    ).toBeUndefined();
  });

  it("does not treat the last Step as the settled state when capture missed it", () => {
    const missing = videoSegment(withVideo, 1);
    expect(seekSeconds(missing, { kind: "settled" })).toBeUndefined();
    expect(missing).toBeDefined();
    if (missing === undefined) {
      return;
    }
    expect(playheadAtSeconds(missing, 0)).toBeUndefined();
  });
});

it("keeps a Gate breach apart from the Run's outcome", () => {
  const breaching = snapshot({
    outcome: "completed",
    phase: "finished",
    run: {
      attempts: [],
      gate: { breached: ["image-alt"], rules: ["image-alt"], source: "flow" },
      outcome: "completed",
      runId: "run-1",
      steps: [],
    } as unknown as never,
  });
  // A breach is a verdict on the site; the Run still completed (ADR 0018).
  expect(breaching.outcome).toBe("completed");
  expect(gateBreach(breaching)).toEqual(["image-alt"]);
  expect(gateBreach(snapshot({}))).toBeUndefined();
});

it("names a navigate Step by where it goes", () => {
  expect(
    describeStep({ type: "navigate", url: "https://example.com/cart" } as never)
  ).toBe("Navigate to example.com/cart");
});

it("distinguishes a container Scroll from a page Scroll", () => {
  expect(
    describeStep({
      deltaY: 200,
      target: [{ kind: "role", name: "Results", role: "region" }],
      type: "scroll",
    } as never)
  ).toBe('Scroll region "Results"');
  expect(describeStep({ deltaY: 200, type: "scroll" } as never)).toBe(
    "Scroll the page"
  );
});

describe("the frame player's timecode", () => {
  it("reads in tenths, because a frame is half a second", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(4.75)).toBe("0:04.8");
    expect(formatTimecode(62.25)).toBe("1:02.3");
    // A video whose metadata never landed reports NaN rather than a length.
    expect(formatTimecode(Number.NaN)).toBe("0:00.0");
  });
});
