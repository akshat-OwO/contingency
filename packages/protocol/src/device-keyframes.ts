import { Schema } from "effect";

import { ContentHash } from "./teaching-recording.ts";

/**
 * One screen a device session kept: the PNG photographed after an action, or
 * at the start and end of the session. Keyframes stay linked to actions as
 * precise evidence beside the session's video, and are all a session recorded
 * before device video existed.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceKeyframe = Schema.Struct({
  capturedAt: Schema.String.check(Schema.isMinLength(1)),
  hash: ContentHash,
});
export type DeviceKeyframe = typeof DeviceKeyframe.Type;

/**
 * A device session's keyframes, oldest first. `retained` is false once the
 * session's files are gone, such as after cleanup deleted a verified Flow's
 * recording; the list then still says how many there were.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceKeyframes = Schema.Struct({
  keyframes: Schema.Array(DeviceKeyframe),
  retained: Schema.Boolean,
});
export type DeviceKeyframes = typeof DeviceKeyframes.Type;

export type DevicePlatform = "android" | "ios";

/** Where a device session lists its keyframes. */
export const deviceKeyframesPath = (
  platform: DevicePlatform,
  sessionId: string
): string => `/${platform}/sessions/${sessionId}/keyframes`;

/** Where one of a device session's keyframes is served as a PNG. */
export const deviceKeyframePath = (
  platform: DevicePlatform,
  sessionId: string,
  hash: string
): string => `${deviceKeyframesPath(platform, sessionId)}/${hash}`;
