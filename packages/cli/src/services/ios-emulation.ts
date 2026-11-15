import type {
  NativeAppearance,
  NativeEmulation,
  NativeLocation,
  NativeOrientation,
} from "@contingency/protocol";
import { Effect } from "effect";

import { iosCommand } from "./ios-simctl.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const failed = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "runtime_failed",
  message:
    "iOS could not read or change the simulator's environment. Execution is paused.",
  operation: "host-io",
});

/** Runs `xcrun simctl <args>` and answers its trimmed stdout. */
export type IosSimctlCommand = (
  args: readonly string[]
) => Effect.Effect<string, PlatformRuntimeError>;

export const iosSimctl: IosSimctlCommand = (args) =>
  iosCommand("xcrun", ["simctl", ...args]).pipe(Effect.mapError(failed));

/**
 * `simctl ui <udid> appearance` prints `light` or `dark`, or `unsupported`
 * and `unknown` on a runtime without one.
 */
export const parseIosAppearance = (
  output: string
): NativeAppearance | undefined => {
  const value = /\b(?<mode>light|dark)\b/iu
    .exec(output)
    ?.groups?.mode?.toLowerCase();
  if (value === "light" || value === "dark") {
    return value;
  }
};

export const readIosAppearance = (simctl: IosSimctlCommand, udid: string) =>
  simctl(["ui", udid, "appearance"]).pipe(
    Effect.flatMap((output) => {
      const appearance = parseIosAppearance(output);
      return appearance === undefined
        ? Effect.fail(failed())
        : Effect.succeed(appearance);
    })
  );

export const setIosAppearance = (
  simctl: IosSimctlCommand,
  udid: string,
  appearance: NativeAppearance
) => simctl(["ui", udid, "appearance", appearance]).pipe(Effect.asVoid);

export const setIosLocation = (
  simctl: IosSimctlCommand,
  udid: string,
  location: NativeLocation
) =>
  simctl([
    "location",
    udid,
    "set",
    `${location.latitude},${location.longitude}`,
  ]).pipe(Effect.asVoid);

/** simctl cannot read a simulated location, only clear it. */
export const clearIosLocation = (simctl: IosSimctlCommand, udid: string) =>
  simctl(["location", udid, "clear"]).pipe(Effect.asVoid);

/** Which way up a screenshot of the given pixel size shows the device. */
export const iosOrientationOf = (size: {
  readonly width: number;
  readonly height: number;
}): NativeOrientation => (size.width > size.height ? "landscape" : "portrait");

/**
 * The simulator's Emulation as a session records it. simctl reads only the
 * appearance: the orientation is the last one the session set, or the one
 * the latest screenshot shows, and the location is the last one the session
 * set, or none (ADR 0082).
 */
export const readIosEmulation = (input: {
  readonly simctl: IosSimctlCommand;
  readonly udid: string;
  readonly orientation: NativeOrientation;
  readonly location: NativeLocation | null;
}) =>
  readIosAppearance(input.simctl, input.udid).pipe(
    Effect.map((appearance): NativeEmulation => ({
      appearance,
      location: input.location,
      orientation: input.orientation,
    }))
  );
