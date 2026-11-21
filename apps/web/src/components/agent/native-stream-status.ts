import { percentile95 } from "@/components/browser/browser-stream-metrics";

/** What a native stage's stream is doing, as its Stream diagnostics reads it. */
export type NativeStreamState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "secure"
  | "unclassified"
  | "lost"
  | "unsupported";

/** How many recent frames the decode and frame-rate readings cover. */
export const NATIVE_FRAME_SAMPLES = 120;
/** The window the frame rate counts shown frames over. */
const FRAME_RATE_WINDOW_MS = 1000;

/** One frame the viewer drew, on the `performance.now()` clock. */
export interface NativeFrameSample {
  /** From handing the frame to the decoder to having it to draw. */
  readonly decodeMs: number | undefined;
  readonly shownAt: number;
}

/**
 * Counts the stream keeps while it runs. They change every frame, so the
 * stream writes them outside React and the open diagnostics card samples
 * them, rather than re-rendering the Workspace per frame.
 */
export interface NativeStreamStats {
  readonly decoded: number;
  /**
   * Frames that reached the viewer but were never drawn: a backlog it
   * dropped to rejoin at the next keyframe, or a frame a newer one replaced.
   */
  readonly dropped: number;
  /** The last {@link NATIVE_FRAME_SAMPLES} frames drawn, oldest first. */
  readonly frames: readonly NativeFrameSample[];
  readonly height: number;
  readonly width: number;
}

export const emptyNativeStreamStats: NativeStreamStats = {
  decoded: 0,
  dropped: 0,
  frames: [],
  height: 0,
  width: 0,
};

/** Counts one drawn frame of the given size. */
export const nativeFrameShown = (
  stats: NativeStreamStats,
  frame: {
    readonly decodeMs: number | undefined;
    readonly height: number;
    readonly width: number;
  },
  shownAt = performance.now()
): NativeStreamStats => ({
  ...stats,
  decoded: stats.decoded + 1,
  frames: [
    ...stats.frames.slice(-(NATIVE_FRAME_SAMPLES - 1)),
    { decodeMs: frame.decodeMs, shownAt },
  ],
  height: frame.height,
  width: frame.width,
});

/** Counts frames the viewer received and will never draw. */
export const nativeFramesDropped = (
  stats: NativeStreamStats,
  count: number
): NativeStreamStats =>
  count <= 0 ? stats : { ...stats, dropped: stats.dropped + count };

/**
 * Each first visible response to the user's input on this platform since
 * `since`, as `makeFirstResponseProbe` measures it: the input-to-frame time.
 */
const inputToFrame = (platform: "android" | "ios", since: number) => {
  const prefix = `contingency:first-visible-response:${platform}:`;
  return performance
    .getEntriesByType("measure")
    .filter(
      (entry) => entry.name.startsWith(prefix) && entry.startTime >= since
    )
    .slice(-NATIVE_FRAME_SAMPLES)
    .map((entry) => entry.duration);
};

/**
 * Times each frame through the decoder, by the whole-microsecond timestamp
 * the decoder hands its frame back with, and counts what a decoder reset
 * drops: the frames still inside it, then every delta until the next
 * keyframe, which cannot be drawn without it.
 */
export const makeDecodeTimer = (backlogLimit: number) => {
  const decoding = new Map<number, number>();
  let rejoining = false;
  return {
    /** How long the frame took to decode, if its chunk was timed. */
    decoded: (timestamp: number) => {
      const started = decoding.get(timestamp);
      decoding.delete(timestamp);
      return started === undefined ? undefined : performance.now() - started;
    },
    /** A chunk went into the decoder. */
    decoding: (timestamp: number) => {
      // A chunk that yields no frame must not hold its entry for ever.
      const oldest = decoding.keys().next();
      if (decoding.size >= backlogLimit && !oldest.done) {
        decoding.delete(oldest.value);
      }
      decoding.set(Math.trunc(timestamp), performance.now());
    },
    /** A keyframe configured the decoder; nothing after it is dropped. */
    keyframe: () => {
      rejoining = false;
    },
    /** The viewer reset the decoder to rejoin at a keyframe; returns the drops. */
    rejoin: () => {
      const dropped = decoding.size;
      decoding.clear();
      rejoining = true;
      return dropped;
    },
    /** The stream changed state; frames in flight are discarded, not dropped. */
    reset: () => {
      decoding.clear();
      rejoining = false;
    },
    /** A delta arrived before any keyframe: 1 if it is a drop, else 0. */
    skipped: () => (rejoining ? 1 : 0),
  };
};

/** Stream diagnostics' reading of the stream at `now`. */
export interface NativeStreamReading {
  readonly decodeP95Ms: number | undefined;
  /** Frames drawn in the last second; a still screen sends none. */
  readonly framesPerSecond: number;
  readonly inputToFrameP95Ms: number | undefined;
}

export const readNativeStream = (
  stats: NativeStreamStats,
  platform: "android" | "ios",
  since: number,
  now = performance.now()
): NativeStreamReading => ({
  decodeP95Ms: percentile95(
    stats.frames.flatMap((frame) =>
      frame.decodeMs === undefined ? [] : [frame.decodeMs]
    )
  ),
  framesPerSecond: stats.frames.filter(
    (frame) => now - frame.shownAt < FRAME_RATE_WINDOW_MS
  ).length,
  inputToFrameP95Ms: percentile95(inputToFrame(platform, since)),
});
