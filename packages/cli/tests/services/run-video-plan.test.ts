import { describe, expect, it } from "vitest";

import {
  fastForwardLabel,
  planRunVideo,
  runOffsetAtVideo,
  runVideoDurationMs,
  segmentAtVideo,
} from "../../src/services/run-video-plan.ts";

describe("planRunVideo", () => {
  it("plays padded Action Windows in real time and fast-forwards the gaps", () => {
    const segments = planRunVideo({
      actions: [
        { fromMs: 1000, toMs: 1200 },
        { fromMs: 9000, toMs: 9300 },
      ],
      durationMs: 12_000,
      fastForward: "fixed",
      takeovers: [],
    });
    expect(
      segments.map(({ kind, runFromMs, runToMs }) => [kind, runFromMs, runToMs])
    ).toEqual([
      ["real-time", 0, 1700],
      ["idle-gap", 1700, 8500],
      ["real-time", 8500, 9800],
      ["idle-gap", 9800, 12_000],
    ]);
    expect(segments[1]?.rate).toBe(2);
    expect(runVideoDurationMs(segments)).toBe(1700 + 3400 + 1300 + 1100);
  });

  it("caps a long Idle Gap at three seconds and reports the real rate", () => {
    const [, gap] = planRunVideo({
      actions: [
        { fromMs: 0, toMs: 100 },
        { fromMs: 40_000, toMs: 40_100 },
      ],
      durationMs: 40_600,
      fastForward: "capped",
      takeovers: [],
    });
    expect(gap?.kind).toBe("idle-gap");
    expect((gap?.videoToMs ?? 0) - (gap?.videoFromMs ?? 0)).toBe(3000);
    expect(gap?.rate).toBeCloseTo(38_900 / 3000);
    expect(fastForwardLabel(gap?.rate ?? 0)).toBe("13x");
  });

  it("keeps a short gap at 2x under the cap", () => {
    const [, gap] = planRunVideo({
      actions: [
        { fromMs: 0, toMs: 100 },
        { fromMs: 4600, toMs: 4700 },
      ],
      durationMs: 5200,
      fastForward: "capped",
      takeovers: [],
    });
    expect(gap?.rate).toBe(2);
    expect(fastForwardLabel(2)).toBe("2x");
  });

  it("plays Takeover in real time, however long", () => {
    const segments = planRunVideo({
      actions: [],
      durationMs: 30_000,
      fastForward: "capped",
      takeovers: [{ fromMs: 5000, toMs: 25_000 }],
    });
    expect(segments.map(({ kind }) => kind)).toEqual([
      "idle-gap",
      "real-time",
      "idle-gap",
    ]);
    expect(segments[1]?.rate).toBe(1);
  });

  it("does not fast-forward a gap too short to be worth a badge", () => {
    const segments = planRunVideo({
      actions: [
        { fromMs: 1000, toMs: 1100 },
        { fromMs: 2400, toMs: 2500 },
      ],
      durationMs: 3000,
      fastForward: "fixed",
      takeovers: [],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "real-time",
      runFromMs: 0,
      runToMs: 3000,
    });
  });

  it("covers a Run with no actions as one Idle Gap", () => {
    const segments = planRunVideo({
      actions: [],
      durationMs: 8000,
      fastForward: "fixed",
      takeovers: [],
    });
    expect(segments).toEqual([
      {
        kind: "idle-gap",
        rate: 2,
        runFromMs: 0,
        runToMs: 8000,
        videoFromMs: 0,
        videoToMs: 4000,
      },
    ]);
  });
});

describe("runOffsetAtVideo", () => {
  const segments = planRunVideo({
    actions: [{ fromMs: 10_000, toMs: 10_000 }],
    durationMs: 20_000,
    fastForward: "fixed",
    takeovers: [],
  });

  it("maps video time back to the moment of the Run it shows", () => {
    // 0–9500 plays in 4750ms, then the padded window in real time.
    expect(runOffsetAtVideo(segments, 0)).toBe(0);
    expect(runOffsetAtVideo(segments, 2000)).toBe(4000);
    expect(runOffsetAtVideo(segments, 4750)).toBe(9500);
    expect(runOffsetAtVideo(segments, 5250)).toBe(10_000);
    expect(segmentAtVideo(segments, 5250)?.kind).toBe("real-time");
  });

  it("holds the Run's end past the video's end", () => {
    expect(runOffsetAtVideo(segments, 1_000_000)).toBe(20_000);
  });
});
