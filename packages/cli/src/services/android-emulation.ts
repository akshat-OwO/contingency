import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  NativeEmulation,
  NativeEmulationChange,
  NativeLocation,
  NativeOrientation,
} from "@contingency/protocol";
import { Duration, Effect, Schedule, Schema } from "effect";

import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const execute = promisify(execFile);

/** Runs `adb -s <serial> <args>` and answers its trimmed stdout. */
export type AndroidAdb = (
  serial: string,
  args: readonly string[]
) => Effect.Effect<string, PlatformRuntimeError>;

export const androidAdb: AndroidAdb = (serial, args) =>
  Effect.tryPromise({
    catch: () => platformRuntimeError("runtime_failed"),
    try: async (signal) => {
      const result = await execute("adb", ["-s", serial, ...args], {
        maxBuffer: 8 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      return result.stdout.trim();
    },
  });

/**
 * The device settings an Emulation change touches, exactly as the device
 * held them, so a restore puts back the rotation lock as well as the rotation.
 */
export const AndroidDeviceEnvironment = Schema.Struct({
  accelerometerRotation: Schema.Literals(["0", "1"]),
  location: Schema.NullOr(
    Schema.Struct({ latitude: Schema.Finite, longitude: Schema.Finite })
  ),
  nightMode: Schema.Literals(["yes", "no", "auto"]),
  /**
   * Quarter turns of an emulator's virtual body, which sets the size of the
   * frames it streams. Null on a phone, whose stream follows its display.
   */
  skinTurns: Schema.NullOr(Schema.Literals([0, 1, 2, 3])),
  userRotation: Schema.Literals(["0", "1", "2", "3"]),
});
export type AndroidDeviceEnvironmentValue =
  typeof AndroidDeviceEnvironment.Type;

const rotationPattern = /mCurrentOrientation=(?<rotation>[0-3])/u;
const nightPattern = /night mode:\s*(?<mode>yes|no|auto)\b/iu;
const gpsPattern =
  /last location=Location\[gps (?<latitude>-?\d+(?:\.\d+)?),(?<longitude>-?\d+(?:\.\d+)?)/u;

const gravityPattern = /acceleration = (?<x>-?[\d.e+-]+):(?<y>-?[\d.e+-]+):/u;

/** An emulator console serial; a phone has none. */
const isEmulator = (serial: string) => /^emulator-\d+$/u.test(serial);

const unreadable = () => Effect.fail(platformRuntimeError("runtime_failed"));

/**
 * How many times the emulator's body has turned, from where gravity points:
 * down the screen upright, then along -x, up, and +x after each turn.
 */
export const parseSkinTurns = (output: string) => {
  const groups = gravityPattern.exec(output)?.groups;
  if (groups?.x === undefined || groups.y === undefined) {
    return;
  }
  const x = Number(groups.x);
  const y = Number(groups.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  if (Math.abs(y) >= Math.abs(x)) {
    return y > 0 ? 0 : 2;
  }
  return x < 0 ? 1 : 3;
};

/** The display's current rotation: 0 and 2 are portrait, 1 and 3 landscape. */
export const parseDisplayRotation = (dump: string) => {
  const rotation = rotationPattern.exec(dump)?.groups?.rotation;
  return rotation === undefined ? undefined : Number(rotation);
};
const nightModes = new Map<string, AndroidDeviceEnvironmentValue["nightMode"]>([
  ["auto", "auto"],
  ["no", "no"],
  ["yes", "yes"],
]);
export const parseNightMode = (output: string) =>
  nightModes.get(nightPattern.exec(output)?.groups?.mode?.toLowerCase() ?? "");
/**
 * The GPS provider's last known fix. It moves only while an app listens, so
 * after setting a location a session keeps the value it set instead.
 */
export const parseGpsLocation = (dump: string): NativeLocation | null => {
  const groups = gpsPattern.exec(dump)?.groups;
  return groups?.latitude === undefined || groups.longitude === undefined
    ? null
    : {
        latitude: Number(groups.latitude),
        longitude: Number(groups.longitude),
      };
};

const setting = (adb: AndroidAdb, serial: string, name: string) =>
  adb(serial, ["shell", "settings", "get", "system", name]);

const displayRotation = (adb: AndroidAdb, serial: string) =>
  adb(serial, ["shell", "dumpsys", "display"]).pipe(
    Effect.flatMap((dump) => {
      const rotation = parseDisplayRotation(dump);
      return rotation === undefined ? unreadable() : Effect.succeed(rotation);
    })
  );

const skinTurns = (adb: AndroidAdb, serial: string) =>
  adb(serial, ["emu", "sensor", "get", "acceleration"]).pipe(
    Effect.flatMap((output) => {
      const turns = parseSkinTurns(output);
      return turns === undefined ? unreadable() : Effect.succeed(turns);
    })
  );

/** Reads the settings an Emulation change would touch. */
export const readAndroidEnvironment = (adb: AndroidAdb, serial: string) =>
  Effect.gen(function* readEnvironment() {
    const [accelerometer, user, night, location, turns] = yield* Effect.all([
      setting(adb, serial, "accelerometer_rotation"),
      setting(adb, serial, "user_rotation"),
      adb(serial, ["shell", "cmd", "uimode", "night"]),
      adb(serial, ["shell", "dumpsys", "location"]),
      isEmulator(serial) ? skinTurns(adb, serial) : Effect.succeed(null),
    ]);
    const nightMode = parseNightMode(night);
    return yield* Schema.decodeUnknownEffect(AndroidDeviceEnvironment)({
      // An unset rotation lock reads as "null"; the device treats it as on.
      accelerometerRotation: accelerometer === "null" ? "1" : accelerometer,
      location: parseGpsLocation(location),
      nightMode,
      skinTurns: turns,
      userRotation: user === "null" ? "0" : user,
    }).pipe(Effect.mapError(() => platformRuntimeError("runtime_failed")));
  });

/** The device's Emulation as a session records it. */
export const readAndroidEmulation = (adb: AndroidAdb, serial: string) =>
  Effect.gen(function* readEmulation() {
    const environment = yield* readAndroidEnvironment(adb, serial);
    const rotation = yield* displayRotation(adb, serial);
    const emulation: NativeEmulation = {
      // Automatic night mode reads as light: it is light until a schedule says otherwise.
      appearance: environment.nightMode === "yes" ? "dark" : "light",
      location: environment.location,
      orientation: rotation % 2 === 0 ? "portrait" : "landscape",
    };
    return emulation;
  });

const ROTATION_SETTLE = Duration.seconds(5);

const putSystemSetting = (
  adb: AndroidAdb,
  serial: string,
  name: "accelerometer_rotation" | "user_rotation",
  value: string
) => adb(serial, ["shell", "settings", "put", "system", name, value]);

/** Waits for the display to turn; a Target App may pin its own orientation. */
const settleDisplay = (
  adb: AndroidAdb,
  serial: string,
  settled: (rotation: number) => boolean
) =>
  displayRotation(adb, serial).pipe(
    Effect.flatMap((current) =>
      settled(current) ? Effect.void : unreadable()
    ),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)) }),
    Effect.timeoutOrElse({
      duration: ROTATION_SETTLE,
      orElse: () => Effect.void,
    })
  );

/** Turns an emulator's body until it has made `target` quarter turns. */
const turnSkin = (adb: AndroidAdb, serial: string, target: number) =>
  Effect.gen(function* turnBody() {
    const current = yield* skinTurns(adb, serial);
    for (let turn = 0; turn < (target - current + 4) % 4; turn += 1) {
      yield* adb(serial, ["emu", "rotate"]);
    }
  });

/**
 * An emulator turns its body, so its stream turns with the display; the
 * display follows with the rotation lock off. A phone's display is turned
 * directly, and its stream follows the display.
 */
const rotate = (
  adb: AndroidAdb,
  serial: string,
  orientation: NativeOrientation
) =>
  Effect.gen(function* rotateDisplay() {
    const landscape = orientation === "landscape";
    if (isEmulator(serial)) {
      yield* putSystemSetting(adb, serial, "accelerometer_rotation", "1");
      yield* turnSkin(adb, serial, landscape ? 1 : 0);
    } else {
      yield* putSystemSetting(adb, serial, "accelerometer_rotation", "0");
      yield* putSystemSetting(
        adb,
        serial,
        "user_rotation",
        landscape ? "1" : "0"
      );
    }
    yield* settleDisplay(
      adb,
      serial,
      (rotation) => rotation % 2 === (landscape ? 1 : 0)
    );
  });

const setLocation = (
  adb: AndroidAdb,
  serial: string,
  location: NativeLocation
) =>
  // The emulator console takes longitude first.
  adb(serial, [
    "emu",
    "geo",
    "fix",
    String(location.longitude),
    String(location.latitude),
  ]).pipe(Effect.asVoid);

/** Applies one Emulation change to an emulator. */
export const applyAndroidEmulationChange = (
  adb: AndroidAdb,
  serial: string,
  change: NativeEmulationChange
) => {
  // All change variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (change._tag) {
    case "orientation": {
      return rotate(adb, serial, change.orientation);
    }
    case "appearance": {
      return adb(serial, [
        "shell",
        "cmd",
        "uimode",
        "night",
        change.appearance === "dark" ? "yes" : "no",
      ]).pipe(Effect.asVoid);
    }
    case "location": {
      return setLocation(adb, serial, change);
    }
  }
};

/** The changes that bring a device to a whole starting Emulation. */
export const emulationChanges = (
  emulation: NativeEmulation
): readonly NativeEmulationChange[] => [
  { _tag: "orientation", orientation: emulation.orientation },
  { _tag: "appearance", appearance: emulation.appearance },
  ...(emulation.location === null
    ? []
    : [{ _tag: "location" as const, ...emulation.location }]),
];

/**
 * Puts back the settings a session found, rotation lock included. An
 * emulator's body turns back first, with the lock off so the display
 * follows. The lock then goes before the rotation: while the lock is on, the
 * window manager rewrites it as it applies a new rotation, so a lock written
 * after the rotation can be lost.
 */
export const restoreAndroidEnvironment = (
  adb: AndroidAdb,
  serial: string,
  environment: AndroidDeviceEnvironmentValue
) =>
  Effect.gen(function* restore() {
    if (environment.skinTurns !== null) {
      yield* putSystemSetting(adb, serial, "accelerometer_rotation", "1");
      yield* turnSkin(adb, serial, environment.skinTurns);
    }
    yield* putSystemSetting(
      adb,
      serial,
      "accelerometer_rotation",
      environment.accelerometerRotation
    );
    yield* putSystemSetting(
      adb,
      serial,
      "user_rotation",
      environment.userRotation
    );
    yield* adb(serial, [
      "shell",
      "cmd",
      "uimode",
      "night",
      environment.nightMode,
    ]);
    if (environment.location !== null) {
      yield* setLocation(adb, serial, environment.location);
    }
  });
