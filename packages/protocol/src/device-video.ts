import { Schema } from "effect";

import type { DevicePlatform } from "./device-keyframes.ts";
import { RunVideoTimeMap } from "./run-video.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const nonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A span of a device recording, in milliseconds from the moment its recorder
 * started: the time map's `startedAt`.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceVideoSpan = Schema.Struct({
  fromMs: nonNegative,
  toMs: nonNegative,
});
export type DeviceVideoSpan = typeof DeviceVideoSpan.Type;

/**
 * Why part of a device recording holds no footage. Each one makes the
 * recording incomplete.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceVideoGapReason = Schema.Literals([
  "recorder-lost",
  "recorder-unconfirmed",
  "recorder-stopped-early",
  "session-recovered",
  "size-limit",
]);
export type DeviceVideoGapReason = typeof DeviceVideoGapReason.Type;

/**
 * What a device recording's footage covers. A Hidden Interval leaves a secure
 * screen out on purpose and does not make the recording incomplete; any gap
 * does, and the video marks each one.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceVideoCapture = Schema.Struct({
  complete: Schema.Boolean,
  gaps: Schema.Array(
    Schema.Struct({
      ...DeviceVideoSpan.fields,
      reason: DeviceVideoGapReason,
    })
  ),
  hidden: Schema.Array(DeviceVideoSpan),
  /** A sentence about what the recorder reported, when it said more. */
  note: Schema.optional(nonEmptyString),
});
export type DeviceVideoCapture = typeof DeviceVideoCapture.Type;

/**
 * Where a device session's video stands. A device records through its own
 * screen recorder from Start to Stop, or across a Run's execution, and the
 * video is rendered after it ends, so the status can be `preparing` while the
 * evidence already exists.
 *
 * - `ready`: the video plays. Teaching plays in real time; a Run or Dry Run is
 *   condensed under ADR 0046. `fallback` says why the raw footage plays
 *   instead of the rendered video.
 * - `not-recorded`: the session kept no video, with why: it was recorded
 *   before device video existed, or its recorder never started.
 * - `unavailable`: a video was recorded but cannot be served.
 * - `purged`: Cleanup deleted it after the user verified the Flow.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceVideoStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("preparing") }),
  Schema.Struct({
    capture: DeviceVideoCapture,
    fallback: Schema.optional(nonEmptyString),
    pacing: Schema.Literals(["condensed", "real-time"]),
    path: nonEmptyString,
    state: Schema.Literal("ready"),
    timeMap: RunVideoTimeMap,
  }),
  Schema.Struct({
    reason: nonEmptyString,
    state: Schema.Literal("not-recorded"),
  }),
  Schema.Struct({
    capture: Schema.optional(DeviceVideoCapture),
    directory: Schema.optional(nonEmptyString),
    reason: nonEmptyString,
    state: Schema.Literal("unavailable"),
  }),
  Schema.Struct({ state: Schema.Literal("purged") }),
]).annotate({ identifier: "DeviceVideoStatus" });
export type DeviceVideoStatus = typeof DeviceVideoStatus.Type;

/** Where a device session's video is served. */
export const deviceVideoPath = (
  platform: DevicePlatform,
  sessionId: string
): string => `/${platform}/sessions/${sessionId}/video`;

/** Where a device session's video status is read. */
export const deviceVideoStatusPath = (
  platform: DevicePlatform,
  sessionId: string
): string => `${deviceVideoPath(platform, sessionId)}/status`;
