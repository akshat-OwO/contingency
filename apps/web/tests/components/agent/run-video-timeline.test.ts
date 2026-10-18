import type {
  AgentTimelineEntry,
  RunVideoTimeMap,
} from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  runVideoChapters,
  videoOffsetMs,
} from "@/components/agent/run-video-timeline";

const startedAt = "2026-09-04T00:00:00.000Z";

// Two Action Windows around a ten-second Idle Gap played at 5x.
const timeMap: RunVideoTimeMap = {
  fastForward: "capped",
  segments: [
    {
      kind: "real-time",
      rate: 1,
      runFromMs: 0,
      runToMs: 2000,
      videoFromMs: 0,
      videoToMs: 2000,
    },
    {
      kind: "idle-gap",
      rate: 5,
      runFromMs: 2000,
      runToMs: 12_000,
      videoFromMs: 2000,
      videoToMs: 4000,
    },
    {
      kind: "real-time",
      rate: 1,
      runFromMs: 12_000,
      runToMs: 15_000,
      videoFromMs: 4000,
      videoToMs: 7000,
    },
  ],
  startedAt,
};

const entry = (offsetMs: number, description: string): AgentTimelineEntry => ({
  actor: "agent",
  at: new Date(Date.parse(startedAt) + offsetMs).toISOString(),
  description,
  dispatched: true,
  id: description,
  outcome: "completed",
});

const timeline = [entry(1000, "Open the store"), entry(13_000, "Add to cart")];

test("places a Run moment in the condensed video through the time map", () => {
  expect(videoOffsetMs(timeMap, true, 1000)).toBe(1000);
  // Halfway through the Idle Gap, which plays five times faster.
  expect(videoOffsetMs(timeMap, true, 7000)).toBe(3000);
  expect(videoOffsetMs(timeMap, true, 13_000)).toBe(5000);
  expect(videoOffsetMs(timeMap, true, 20_000)).toBe(7000);
  expect(videoOffsetMs(timeMap, true, -1)).toBeUndefined();
  // A video that could not be condensed plays the footage in real time.
  expect(videoOffsetMs(timeMap, false, 13_000)).toBe(13_000);
});

test("opens a chapter at each action, after a lead-in", () => {
  const chapters = runVideoChapters({
    barCount: 70,
    condensed: true,
    durationMs: 7000,
    timeMap,
    timeline,
  });
  expect(
    chapters.map(({ action, fromMs, label, toMs }) => ({
      action,
      fromMs,
      label,
      toMs,
    }))
  ).toEqual([
    {
      action: undefined,
      fromMs: 0,
      label: "Before the first action",
      toMs: 1000,
    },
    { action: 1, fromMs: 1000, label: "Open the store", toMs: 5000 },
    { action: 2, fromMs: 5000, label: "Add to cart", toMs: 7000 },
  ]);
  // Bars are shared out by each chapter's length.
  expect(chapters.map(({ bars }) => bars.length)).toEqual([10, 40, 20]);
});

test("drops bars through Idle Gaps and peaks them at actions", () => {
  const bars = runVideoChapters({
    barCount: 70,
    condensed: true,
    durationMs: 7000,
    timeMap,
    timeline,
  }).flatMap((chapter) => chapter.bars);
  const at = (ms: number) =>
    bars.toSorted(
      (left, right) => Math.abs(left.atMs - ms) - Math.abs(right.atMs - ms)
    )[0]?.height ?? 0;
  expect(at(3000)).toBeCloseTo(0.18);
  expect(at(1000)).toBeGreaterThan(0.95);
  expect(at(5000)).toBeGreaterThan(0.95);
  // Inside an Action Window but away from the action itself.
  expect(at(6900)).toBeGreaterThanOrEqual(0.4);
  expect(at(6900)).toBeLessThan(at(5000));
});

test("folds a short lead-in into the first action", () => {
  const chapters = runVideoChapters({
    barCount: 70,
    condensed: true,
    durationMs: 7000,
    timeMap,
    timeline: [entry(100, "Open the store")],
  });
  expect(chapters).toHaveLength(1);
  expect(chapters[0]).toMatchObject({
    action: 1,
    fromMs: 0,
    label: "Open the store",
    toMs: 7000,
  });
});

test("keeps a video without a time map as one chapter of even bars", () => {
  const chapters = runVideoChapters({
    barCount: 20,
    condensed: true,
    durationMs: 4000,
    timeMap: undefined,
    timeline,
  });
  expect(chapters).toHaveLength(1);
  expect(chapters[0]?.label).toBe("Run video");
  expect(new Set(chapters[0]?.bars.map(({ height }) => height))).toEqual(
    new Set([0.5])
  );
});

test("has nothing to draw before the duration is known", () => {
  expect(
    runVideoChapters({
      barCount: 20,
      condensed: true,
      durationMs: 0,
      timeMap,
      timeline,
    })
  ).toEqual([]);
});
