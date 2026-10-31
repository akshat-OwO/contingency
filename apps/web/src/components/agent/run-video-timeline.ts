import type {
  AgentTimelineEntry,
  RunVideoTimeMap,
} from "@contingency/protocol";

/** One bar of the scrubber, at a moment of the video. */
export interface RunVideoBar {
  readonly atMs: number;
  /** How much the agent was doing around `atMs`, from 0 to 1. */
  readonly height: number;
}

/**
 * One stretch of the scrubber: an action from the moment it plays until the
 * next one does, or the lead-in before the first action.
 */
export interface RunVideoChapter {
  /** One-based position in the Run's timeline; absent for the lead-in. */
  readonly action: number | undefined;
  readonly bars: readonly RunVideoBar[];
  readonly fromMs: number;
  readonly label: string;
  readonly toMs: number;
}

/** A bar for footage whose activity is unknown, such as a legacy Run's. */
const UNKNOWN_HEIGHT = 0.5;
/** A fast-forwarded Idle Gap: the agent was not acting. */
const IDLE_HEIGHT = 0.18;
/** An Action Window, before the peak around the action itself. */
const ACTION_WINDOW_HEIGHT = 0.4;
/** How far an action's peak spreads either side of it in the video. */
const ACTION_PEAK_SPREAD_MS = 700;
/** A lead-in shorter than this belongs to the first action. */
const MIN_LEAD_IN_MS = 250;

/**
 * Where a Run moment plays in its video. A condensed video is not wall-clock
 * time, so the moment goes through the time map; a video that could not be
 * condensed plays the footage in real time from the map's `startedAt`
 * ([ADR 0046](../../../../../docs/adr/0046-run-video-condenses-idle-gaps-and-composites-the-agent-cursor.md)).
 */
export const videoOffsetMs = (
  timeMap: RunVideoTimeMap,
  condensed: boolean,
  runMs: number
): number | undefined => {
  if (!Number.isFinite(runMs) || runMs < 0) {
    return undefined;
  }
  if (!condensed) {
    return runMs;
  }
  const segment = timeMap.segments.find(
    ({ runFromMs, runToMs }) => runMs >= runFromMs && runMs < runToMs
  );
  if (segment === undefined) {
    const last = timeMap.segments.at(-1);
    return last !== undefined && runMs >= last.runToMs
      ? last.videoToMs
      : undefined;
  }
  return segment.videoFromMs + (runMs - segment.runFromMs) / segment.rate;
};

/** Whether the video at `videoMs` is a fast-forwarded Idle Gap. */
const isIdleAt = (
  timeMap: RunVideoTimeMap,
  condensed: boolean,
  videoMs: number
): boolean =>
  timeMap.segments.some((segment) => {
    const [fromMs, toMs] = condensed
      ? [segment.videoFromMs, segment.videoToMs]
      : [segment.runFromMs, segment.runToMs];
    return segment.kind === "idle-gap" && videoMs >= fromMs && videoMs < toMs;
  });

/**
 * The scrubber's chapters and bars for a Run's video. Each action in the
 * timeline opens a chapter at the moment it plays. Bars stand tall through
 * Action Windows, peak at each action, and drop low through Idle Gaps, so the
 * fast-forwarded stretches read at a glance. Without a time map, nothing can
 * be placed, so the video is one chapter of even bars.
 */
export const runVideoChapters = ({
  barCount,
  condensed,
  durationMs,
  timeMap,
  timeline,
}: {
  readonly barCount: number;
  readonly condensed: boolean;
  readonly durationMs: number;
  readonly timeMap: RunVideoTimeMap | undefined;
  readonly timeline: readonly AgentTimelineEntry[];
}): readonly RunVideoChapter[] => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }
  const startedAt =
    timeMap === undefined ? Number.NaN : Date.parse(timeMap.startedAt);
  const actions =
    timeMap === undefined || Number.isNaN(startedAt)
      ? []
      : timeline
          .map((entry, index) => ({
            action: index + 1,
            atMs: videoOffsetMs(
              timeMap,
              condensed,
              Date.parse(entry.at) - startedAt
            ),
            label: entry.description,
          }))
          .filter(
            (action): action is typeof action & { atMs: number } =>
              action.atMs !== undefined && action.atMs < durationMs
          )
          .toSorted((left, right) => left.atMs - right.atMs);

  const height = (atMs: number): number => {
    if (timeMap === undefined) {
      return UNKNOWN_HEIGHT;
    }
    if (isIdleAt(timeMap, condensed, atMs)) {
      return IDLE_HEIGHT;
    }
    const peak = Math.max(
      0,
      ...actions.map((action) =>
        Math.exp(-(((atMs - action.atMs) / ACTION_PEAK_SPREAD_MS) ** 2))
      )
    );
    return ACTION_WINDOW_HEIGHT + (1 - ACTION_WINDOW_HEIGHT) * peak;
  };

  const [first] = actions;
  const leadIn = first === undefined || first.atMs >= MIN_LEAD_IN_MS;
  const stops = [
    ...(leadIn
      ? [
          {
            action: undefined,
            atMs: 0,
            label:
              first === undefined ? "Run video" : "Before the first action",
          },
        ]
      : []),
    ...actions.map((action, index) =>
      index === 0 && !leadIn ? { ...action, atMs: 0 } : action
    ),
  ];
  const chapters: RunVideoChapter[] = [];
  for (const [index, stop] of stops.entries()) {
    const fromMs = stop.atMs;
    const toMs = stops[index + 1]?.atMs ?? durationMs;
    const span = toMs - fromMs;
    // Two actions at the same moment: the later one names the chapter.
    if (span > 0) {
      // Allocate from cumulative boundaries so short chapters do not each
      // force an extra bar beyond the measured track budget.
      const count =
        Math.round((barCount * toMs) / durationMs) -
        Math.round((barCount * fromMs) / durationMs);
      chapters.push({
        action: stop.action,
        bars: Array.from({ length: count }, (_, bar) => {
          const atMs = fromMs + ((bar + 0.5) * span) / count;
          return { atMs, height: height(atMs) };
        }),
        fromMs,
        label: stop.label,
        toMs,
      });
    }
  }
  return chapters;
};
