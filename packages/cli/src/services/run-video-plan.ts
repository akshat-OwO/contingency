import type {
  RunVideoFastForward,
  RunVideoSegment,
} from "@contingency/protocol";

/** A span of the Run, in milliseconds from its first captured frame. */
export interface RunSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Padding on each side of an Action Window, so a watcher sees the Page before
 * the agent reaches for it and the Page answering afterwards.
 */
export const ACTION_PADDING_MS = 500;

/**
 * A gap shorter than this plays in real time. Fast-forwarding a fraction of a
 * second would flash the badge between two actions without saving any time.
 */
export const MIN_IDLE_GAP_MS = 1000;

export const IDLE_GAP_RATE = 2;

/** The longest an Idle Gap plays for under `capped`. */
export const IDLE_GAP_CAP_MS = 3000;

/** The video's frame rate, and so the grid every boundary is rounded to. */
export const RUN_VIDEO_FRAME_MS = 40;

const merged = (spans: readonly RunSpan[]): RunSpan[] => {
  const sorted = spans.toSorted((left, right) => left.fromMs - right.fromMs);
  const result: RunSpan[] = [];
  for (const span of sorted) {
    const last = result.at(-1);
    if (last !== undefined && span.fromMs <= last.toMs) {
      result[result.length - 1] = {
        fromMs: last.fromMs,
        toMs: Math.max(last.toMs, span.toMs),
      };
    } else {
      result.push(span);
    }
  }
  return result;
};

const idlePlayback = (
  gapMs: number,
  fastForward: RunVideoFastForward
): number => {
  const doubled = gapMs / IDLE_GAP_RATE;
  return fastForward === "capped"
    ? Math.min(doubled, IDLE_GAP_CAP_MS)
    : doubled;
};

/**
 * Lay a Run out as its video plays it: Action Windows and Takeover in real
 * time, every Idle Gap between them fast-forwarded. The segments cover the
 * whole Run, in order, without overlap.
 */
export const planRunVideo = (input: {
  readonly actions: readonly RunSpan[];
  readonly durationMs: number;
  readonly fastForward: RunVideoFastForward;
  readonly takeovers: readonly RunSpan[];
}): readonly RunVideoSegment[] => {
  const durationMs = Math.max(0, input.durationMs);
  const clip = (span: RunSpan): RunSpan => ({
    fromMs: Math.min(durationMs, Math.max(0, span.fromMs)),
    toMs: Math.min(durationMs, Math.max(0, span.toMs)),
  });
  const realTime = merged([
    ...input.actions.map((span) =>
      clip({
        fromMs: span.fromMs - ACTION_PADDING_MS,
        toMs: span.toMs + ACTION_PADDING_MS,
      })
    ),
    ...input.takeovers.map(clip),
  ]).filter((span) => span.toMs > span.fromMs);

  // Walk the Run, alternating idle and real-time spans; a gap too short to
  // fast-forward joins the real time around it.
  const spans: { kind: RunVideoSegment["kind"]; span: RunSpan }[] = [];
  const push = (kind: RunVideoSegment["kind"], span: RunSpan) => {
    if (span.toMs <= span.fromMs) {
      return;
    }
    const resolved =
      kind === "idle-gap" && span.toMs - span.fromMs < MIN_IDLE_GAP_MS
        ? "real-time"
        : kind;
    const last = spans.at(-1);
    if (last !== undefined && last.kind === resolved) {
      last.span = { fromMs: last.span.fromMs, toMs: span.toMs };
      return;
    }
    spans.push({ kind: resolved, span });
  };
  let cursor = 0;
  for (const span of realTime) {
    push("idle-gap", { fromMs: cursor, toMs: span.fromMs });
    push("real-time", span);
    cursor = span.toMs;
  }
  push("idle-gap", { fromMs: cursor, toMs: durationMs });

  let videoMs = 0;
  return spans.map(({ kind, span }) => {
    const runMs = span.toMs - span.fromMs;
    const playbackMs =
      kind === "real-time" ? runMs : idlePlayback(runMs, input.fastForward);
    const segment: RunVideoSegment = {
      kind,
      rate: kind === "real-time" ? 1 : runMs / playbackMs,
      runFromMs: span.fromMs,
      runToMs: span.toMs,
      videoFromMs: videoMs,
      videoToMs: videoMs + playbackMs,
    };
    videoMs += playbackMs;
    return segment;
  });
};

export const runVideoDurationMs = (
  segments: readonly RunVideoSegment[]
): number => segments.at(-1)?.videoToMs ?? 0;

/** The segment playing at `videoMs`; the last one past the end. */
export const segmentAtVideo = (
  segments: readonly RunVideoSegment[],
  videoMs: number
): RunVideoSegment | undefined => {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const segment = segments[middle];
    if (segment !== undefined && segment.videoFromMs <= videoMs) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return segments[low];
};

/** The moment of the Run the video shows at `videoMs`. */
export const runOffsetAtVideo = (
  segments: readonly RunVideoSegment[],
  videoMs: number
): number => {
  const segment = segmentAtVideo(segments, videoMs);
  if (segment === undefined) {
    return 0;
  }
  const into = Math.min(
    Math.max(0, videoMs - segment.videoFromMs),
    segment.videoToMs - segment.videoFromMs
  );
  return Math.min(segment.runToMs, segment.runFromMs + into * segment.rate);
};

/** The badge an Idle Gap shows: its real multiplier, rounded. */
export const fastForwardLabel = (rate: number): string =>
  `${Math.max(IDLE_GAP_RATE, Math.round(rate))}x`;
