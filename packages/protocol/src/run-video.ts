import { Schema } from "effect";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const nonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * How a Run's video fast-forwards its Idle Gaps. `capped` plays a gap at 2x
 * but never for longer than a few seconds, so a long think is cut short;
 * `fixed` plays every gap at exactly 2x. It is chosen once per process, not
 * per Run, because the real-time recording does not survive the encode.
 */
export const RunVideoFastForward = Schema.Literals(["capped", "fixed"]);
export type RunVideoFastForward = typeof RunVideoFastForward.Type;

/**
 * One span of a Run's video. `real-time` covers Action Windows and Takeover,
 * played at their own speed; `idle-gap` is fast-forwarded by `rate`. Run
 * offsets count from the time map's `startedAt`.
 */
export const RunVideoSegment = Schema.Struct({
  kind: Schema.Literals(["real-time", "idle-gap"]),
  rate: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
  runFromMs: nonNegative,
  runToMs: nonNegative,
  videoFromMs: nonNegative,
  videoToMs: nonNegative,
});
export type RunVideoSegment = typeof RunVideoSegment.Type;

/**
 * How a Run's video relates to the Run itself. The video is not wall-clock
 * time, so anything that seeks to a moment of the Run goes through this map
 * ([ADR 0046](../../../docs/adr/0046-run-video-condenses-idle-gaps-and-composites-the-agent-cursor.md)).
 */
export const RunVideoTimeMap = Schema.Struct({
  fastForward: RunVideoFastForward,
  segments: Schema.Array(RunVideoSegment),
  /** The wall-clock moment of Run offset zero: the first captured frame. */
  startedAt: nonEmptyString,
}).annotate({ identifier: "RunVideoTimeMap" });
export type RunVideoTimeMap = typeof RunVideoTimeMap.Type;

/**
 * Where a finished Run's video stands. The video is encoded after the Run
 * ends, so a Run Summary can exist before its video does. A video that could
 * not be condensed is still served, in real time, with the reason.
 */
export const RunVideoStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("preparing") }),
  Schema.Struct({
    condensed: Schema.Literal(true),
    state: Schema.Literal("ready"),
  }),
  Schema.Struct({
    condensed: Schema.Literal(false),
    reason: nonEmptyString,
    state: Schema.Literal("ready"),
  }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]).annotate({ identifier: "RunVideoStatus" });
export type RunVideoStatus = typeof RunVideoStatus.Type;

/** The status of the video served at `videoUrl`. */
export const runVideoStatusPath = (videoUrl: string): string =>
  `${videoUrl}/status`;

/** Where the latest Dry Run of a Teaching Recording serves its video. */
export const dryRunVideoPath = (recordingId: string): string =>
  `/teaching-recordings/${recordingId}/dry-run/video`;
