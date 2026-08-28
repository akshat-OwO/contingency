import type { RunSnapshot, RunStep } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  attempts,
  attemptSteps,
  gateBreach,
  seekSeconds,
  selectedAttempt,
  selectedStepIndex,
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

  it("seeks a Step to its own frame", () => {
    expect(seekSeconds(videoSegment(withVideo, 2), 1)).toBe(0.75);
    expect(seekSeconds(videoSegment(withVideo, 2), following)).toBeUndefined();
    expect(seekSeconds(videoSegment(withVideo, 1), 0)).toBeUndefined();
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
