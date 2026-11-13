import type {
  DeviceVideoCapture,
  DeviceVideoGapReason,
  DeviceVideoSpan,
  RunVideoFastForward,
  RunVideoSegment,
  RunVideoTimeMap,
} from "@contingency/protocol";

import { planRunVideo } from "./run-video-plan.ts";

/**
 * How often agent-device starts Android's next recorder, before
 * `screenrecord` reaches its 180-second limit. It stops the previous recorder
 * only once the next one shows frames, so chunks overlap and a handover loses
 * no footage.
 */
export const ANDROID_ROTATION_MS = 170_000;

/**
 * How long the next recorder takes to show frames after agent-device starts
 * it. Measured on an emulator: a first chunk played 171.4 s, which covers this
 * launch and the previous recorder's stop.
 */
export const ANDROID_CHUNK_LAUNCH_MS = 1000;

/** The longest side of a device video. */
export const DEVICE_VIDEO_MAX_SIDE = 1280;

/** One footage file and where it sits in the recording. */
export interface DeviceFootageChunk {
  /** Milliseconds from the recorder's start to this file's first frame. */
  readonly startMs: number;
  /** Presentation times of its frames, ascending, from the file's own zero. */
  readonly frames: readonly number[];
  /** How long the file plays. */
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
}

/** What the recording's capture recorded about itself, from Start to Stop. */
export interface DeviceCaptureFacts {
  /** Milliseconds the recording ran for. */
  readonly durationMs: number;
  readonly pacing: "condensed" | "real-time";
  readonly fastForward: RunVideoFastForward;
  /** Epoch milliseconds of the recorder's start: the time map's zero. */
  readonly startedAt: number;
  readonly actions: readonly DeviceVideoSpan[];
  readonly takeovers: readonly DeviceVideoSpan[];
  readonly hidden: readonly DeviceVideoSpan[];
  /** Spans the session itself knows lost footage, such as a recovery. */
  readonly interruptions: readonly (DeviceVideoSpan & {
    readonly reason: DeviceVideoGapReason;
  })[];
  readonly recorder: "confirmed" | "unconfirmed" | "lost" | undefined;
  /** The recorder stopped on its own before Stop, such as at a time limit. */
  readonly stoppedEarly: boolean;
  /** Footage dropped at the size limit from this offset on. */
  readonly sizeLimitFromMs: number | undefined;
  readonly note: string | undefined;
}

const clip = (span: DeviceVideoSpan, durationMs: number): DeviceVideoSpan => ({
  fromMs: Math.min(durationMs, Math.max(0, span.fromMs)),
  toMs: Math.min(durationMs, Math.max(0, span.toMs)),
});

/**
 * Where each chunk starts. A chunk after the first starts one rotation and one
 * launch after the one before it. Its file cannot say so itself: Android
 * encodes a frame only when the screen changes, so a chunk's own length ends
 * at its last change.
 */
export const chunkStarts = (count: number): readonly number[] =>
  Array.from(
    { length: count },
    (_, index) => index * (ANDROID_ROTATION_MS + ANDROID_CHUNK_LAUNCH_MS)
  );

/** The last footage any chunk shows, from the recorder's start. */
const coveredUntil = (chunks: readonly DeviceFootageChunk[]) =>
  Math.max(
    0,
    ...chunks.map(
      (chunk) =>
        chunk.startMs + Math.max(chunk.durationMs, chunk.frames.at(-1) ?? 0)
    )
  );

/**
 * What the footage covers: Hidden Intervals, and every span the recording has
 * no proof of. Only a Hidden Interval leaves the recording complete.
 */
export const deviceVideoCapture = (
  facts: DeviceCaptureFacts,
  chunks: readonly DeviceFootageChunk[]
): DeviceVideoCapture => {
  const { durationMs } = facts;
  const gaps = facts.interruptions.map((interruption) => ({
    ...interruption,
    ...clip(interruption, durationMs),
  }));
  const covered = coveredUntil(chunks);
  if (facts.sizeLimitFromMs !== undefined) {
    gaps.push({
      fromMs: Math.min(durationMs, facts.sizeLimitFromMs),
      reason: "size-limit",
      toMs: durationMs,
    });
  } else if (facts.recorder === "lost" || facts.recorder === "unconfirmed") {
    // Nothing proves the recorder kept recording after its last frame.
    gaps.push({
      fromMs: Math.min(durationMs, covered),
      reason:
        facts.recorder === "lost" ? "recorder-lost" : "recorder-unconfirmed",
      toMs: durationMs,
    });
  } else if (facts.stoppedEarly) {
    gaps.push({
      fromMs: Math.min(durationMs, covered),
      reason: "recorder-stopped-early",
      toMs: durationMs,
    });
  }
  const kept = gaps
    .filter(
      (gap) =>
        gap.toMs > gap.fromMs ||
        gap.reason === "recorder-lost" ||
        gap.reason === "recorder-unconfirmed"
    )
    .toSorted((left, right) => left.fromMs - right.fromMs);
  return {
    complete: kept.length === 0,
    gaps: kept,
    hidden: facts.hidden.flatMap((span) => {
      const clipped = clip(span, durationMs);
      return clipped.toMs > clipped.fromMs ? [clipped] : [];
    }),
    note: facts.note,
  };
};

/**
 * How the device video plays the recording. A Run or Dry Run is condensed
 * like a browser Run (ADR 0046); Teaching plays in real time. Either way the
 * segments place every moment of the recording in the video.
 */
export const deviceVideoSegments = (
  facts: DeviceCaptureFacts
): readonly RunVideoSegment[] =>
  facts.pacing === "condensed"
    ? planRunVideo({
        actions: facts.actions,
        durationMs: facts.durationMs,
        fastForward: facts.fastForward,
        takeovers: facts.takeovers,
      })
    : [
        {
          kind: "real-time",
          rate: 1,
          runFromMs: 0,
          runToMs: Math.max(0, facts.durationMs),
          videoFromMs: 0,
          videoToMs: Math.max(0, facts.durationMs),
        },
      ];

export const deviceVideoTimeMap = (
  facts: DeviceCaptureFacts
): RunVideoTimeMap => ({
  fastForward: facts.fastForward,
  segments: deviceVideoSegments(facts),
  startedAt: new Date(facts.startedAt).toISOString(),
});

/** VP9 wants even dimensions. */
const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

/**
 * The video's fixed size: the largest footage frame, fitted inside the
 * longest-side limit. Footage of another shape, such as after a rotation, is
 * letterboxed into it.
 */
export const deviceVideoSize = (
  chunks: readonly Pick<DeviceFootageChunk, "width" | "height">[]
) => {
  const width = Math.max(2, ...chunks.map((chunk) => chunk.width));
  const height = Math.max(2, ...chunks.map((chunk) => chunk.height));
  const scale = Math.min(1, DEVICE_VIDEO_MAX_SIDE / Math.max(width, height));
  // Rounded first: the fitted side lands on the limit, not a hair under it.
  return {
    height: even(Math.round(height * scale)),
    width: even(Math.round(width * scale)),
  };
};

/** What one moment of the recording shows. */
export type DeviceVideoFrame =
  | {
      readonly kind: "footage";
      readonly chunk: number;
      readonly frame: number;
      /** Where to seek the chunk, in seconds. */
      readonly seek: number;
      /** A short-lived capture gap is held on the last frame, with a badge. */
      readonly gap: boolean;
    }
  | { readonly kind: "hidden" }
  | { readonly kind: "missing" };

const within = (spans: readonly DeviceVideoSpan[], atMs: number) =>
  spans.some((span) => atMs >= span.fromMs && atMs < span.toMs);

/** The frame of a chunk showing at `atMs`: the last presented at or before it. */
export const frameIndexAt = (
  frames: readonly number[],
  atMs: number
): number => {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((frames[middle] ?? 0) <= atMs) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

/**
 * What the recording shows at `atMs` from its start. A Hidden Interval shows
 * its card. A gap holds the last frame before it; one with nothing before it
 * shows the missing card. Android encodes a frame only when the screen
 * changes, so the time after a chunk's last frame shows that frame.
 */
export const deviceFrameAt = (
  chunks: readonly DeviceFootageChunk[],
  capture: DeviceVideoCapture,
  atMs: number
): DeviceVideoFrame => {
  if (within(capture.hidden, atMs)) {
    return { kind: "hidden" };
  }
  const gap = capture.gaps.some(
    (span) => atMs >= span.fromMs && atMs < span.toMs
  );
  let index = -1;
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.startMs <= atMs) {
      index = position;
    }
  }
  const chunk = chunks[index];
  if (chunk === undefined || chunk.frames.length === 0) {
    return { kind: "missing" };
  }
  const local = atMs - chunk.startMs;
  if (local < (chunk.frames[0] ?? 0)) {
    return { kind: "missing" };
  }
  const frame = frameIndexAt(chunk.frames, local);
  return {
    chunk: index,
    frame,
    gap,
    kind: "footage",
    // Just past the frame's own stamp, so rounding never lands on the one
    // before it.
    seek: ((chunk.frames[frame] ?? 0) + 1) / 1000,
  };
};
