import { describe, expect, it } from "vitest";

import {
  ANDROID_CHUNK_LAUNCH_MS,
  ANDROID_ROTATION_MS,
  chunkStarts,
  deviceFrameAt,
  deviceVideoCapture,
  deviceVideoSegments,
  deviceVideoSize,
} from "../../src/services/device-video-plan.ts";
import type {
  DeviceCaptureFacts,
  DeviceFootageChunk,
} from "../../src/services/device-video-plan.ts";

const facts = (
  change: Partial<DeviceCaptureFacts> = {}
): DeviceCaptureFacts => ({
  actions: [],
  durationMs: 10_000,
  fastForward: "capped",
  hidden: [],
  note: undefined,
  pacing: "real-time",
  recorder: "confirmed",
  sizeLimitFromMs: undefined,
  startedAt: 1_000_000,
  stoppedEarly: false,
  takeovers: [],
  ...change,
});

const chunk = (
  startMs: number,
  frames: readonly number[],
  durationMs = frames.at(-1) ?? 0
): DeviceFootageChunk => ({
  durationMs,
  frames,
  height: 2400,
  startMs,
  width: 1080,
});

describe("deviceVideoCapture", () => {
  it("keeps a chunked recording complete: its handovers overlap", () => {
    const starts = chunkStarts(3);
    const period = ANDROID_ROTATION_MS + ANDROID_CHUNK_LAUNCH_MS;
    expect(starts).toEqual([0, period, 2 * period]);
    // As measured: a chunk plays a little past the next one's start.
    const capture = deviceVideoCapture(
      facts({ durationMs: 400_000 }),
      starts.map((start) => chunk(start, [0, 1000], 171_400))
    );
    expect(capture).toMatchObject({ complete: true, gaps: [] });
  });

  it("leaves everything after the last frame unproven when the recorder was lost", () => {
    const capture = deviceVideoCapture(facts({ recorder: "lost" }), [
      chunk(0, [0, 3000, 4000]),
    ]);
    expect(capture).toMatchObject({
      complete: false,
      gaps: [{ fromMs: 4000, reason: "recorder-lost", toMs: 10_000 }],
    });
  });

  it("says where the size limit dropped footage, and clips Hidden Intervals", () => {
    const capture = deviceVideoCapture(
      facts({
        hidden: [
          { fromMs: 2000, toMs: 3000 },
          { fromMs: 9500, toMs: 12_000 },
          { fromMs: 11_000, toMs: 12_000 },
        ],
        note: "Video capture ended at its size limit.",
        sizeLimitFromMs: 6000,
      }),
      [chunk(0, [0, 5000])]
    );
    expect(capture).toEqual({
      complete: false,
      gaps: [{ fromMs: 6000, reason: "size-limit", toMs: 10_000 }],
      hidden: [
        { fromMs: 2000, toMs: 3000 },
        { fromMs: 9500, toMs: 10_000 },
      ],
      note: "Video capture ended at its size limit.",
    });
  });
});

describe("deviceVideoSegments", () => {
  it("plays Teaching in real time from start to end", () => {
    expect(deviceVideoSegments(facts())).toEqual([
      {
        kind: "real-time",
        rate: 1,
        runFromMs: 0,
        runToMs: 10_000,
        videoFromMs: 0,
        videoToMs: 10_000,
      },
    ]);
  });

  it("condenses a Run around its actions", () => {
    const segments = deviceVideoSegments(
      facts({
        actions: [{ fromMs: 8000, toMs: 8200 }],
        durationMs: 30_000,
        pacing: "condensed",
      })
    );
    expect(segments.some((segment) => segment.kind === "idle-gap")).toBe(true);
    expect(segments.at(-1)?.runToMs).toBe(30_000);
  });
});

describe("deviceFrameAt", () => {
  const chunks = [
    chunk(0, [500, 1000, 4000, 171_000]),
    chunk(171_000, [0, 2000]),
  ];
  const capture = deviceVideoCapture(facts({ durationMs: 190_000 }), chunks);

  it("shows the last frame presented at or before a moment", () => {
    expect(deviceFrameAt(chunks, capture, 3999)).toEqual({
      chunk: 0,
      frame: 1,
      gap: false,
      kind: "footage",
      seek: 1.001,
    });
    // Android encodes only on change: the last frame holds until the next one.
    expect(deviceFrameAt(chunks, capture, 100_000)).toMatchObject({
      chunk: 0,
      frame: 2,
    });
    expect(deviceFrameAt(chunks, capture, 173_500)).toMatchObject({
      chunk: 1,
      frame: 1,
      gap: false,
    });
  });

  it("shows the newer chunk where two overlap", () => {
    expect(deviceFrameAt(chunks, capture, 171_200)).toMatchObject({
      chunk: 1,
      frame: 0,
      kind: "footage",
    });
  });

  it("holds the last frame through a gap and says so", () => {
    // The recorder was lost after the first chunk's last frame.
    const first = [chunks[0] ?? chunk(0, [0])];
    const lost = deviceVideoCapture(
      facts({ durationMs: 190_000, recorder: "lost" }),
      first
    );
    expect(deviceFrameAt(first, lost, 180_000)).toMatchObject({
      chunk: 0,
      frame: 3,
      gap: true,
    });
  });

  it("shows a card before the first frame and over a Hidden Interval", () => {
    expect(deviceFrameAt(chunks, capture, 200)).toEqual({ kind: "missing" });
    const hidden = { ...capture, hidden: [{ fromMs: 900, toMs: 1100 }] };
    expect(deviceFrameAt(chunks, hidden, 1000)).toEqual({ kind: "hidden" });
  });
});

describe("deviceVideoSize", () => {
  it("fits the largest footage inside the longest-side limit, in even pixels", () => {
    expect(deviceVideoSize([{ height: 2424, width: 1080 }])).toEqual({
      height: 1280,
      width: 570,
    });
    expect(
      deviceVideoSize([
        { height: 2400, width: 1080 },
        { height: 1080, width: 2400 },
      ])
    ).toEqual({ height: 1280, width: 1280 });
    expect(deviceVideoSize([{ height: 801, width: 401 }])).toEqual({
      height: 800,
      width: 400,
    });
  });
});
