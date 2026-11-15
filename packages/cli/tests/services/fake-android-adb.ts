import { Effect } from "effect";

import type { AndroidAdb } from "../../src/services/android-emulation.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import type { PlatformRuntimeError } from "../../src/services/platform-runtime.ts";

/** The device settings an Emulation change touches, as an emulator holds them. */
export interface FakeAndroidDevice {
  accelerometerRotation: string;
  userRotation: string;
  nightMode: "yes" | "no" | "auto";
  /** The GPS provider's last known fix. */
  gps: { latitude: number; longitude: number } | null;
  /** The location the emulator console last set. */
  consoleLocation: { latitude: number; longitude: number } | null;
  /** Quarter turns of the emulator's body, which the display follows while auto-rotate is on. */
  skinTurns: number;
  avd: string;
}

export const fakeAndroidDevice = (
  overrides: Partial<FakeAndroidDevice> = {}
): FakeAndroidDevice => ({
  accelerometerRotation: "1",
  avd: "fixture",
  consoleLocation: null,
  gps: { latitude: 39.2, longitude: -123.1 },
  nightMode: "no",
  skinTurns: 0,
  userRotation: "0",
  ...overrides,
});

type Answer = Effect.Effect<string, PlatformRuntimeError> | undefined;

/** The display rotation an emulator's body shows; upside down is refused. */
const skinDisplay = [0, 3, 3, 1];
const gravity = ["0:9.81:0", "-9.81:0:0", "0:-9.81:0", "9.81:0:0"];

const consoleCommand = (
  device: FakeAndroidDevice,
  line: string,
  turn: (rotation: number) => void
): Answer => {
  if (line === "avd name") {
    return Effect.succeed(`${device.avd}\nOK`);
  }
  if (line === "sensor get acceleration") {
    return Effect.succeed(`acceleration = ${gravity[device.skinTurns]}\nOK`);
  }
  if (line === "rotate") {
    device.skinTurns = (device.skinTurns + 1) % 4;
    if (device.accelerometerRotation === "1") {
      turn(skinDisplay[device.skinTurns] ?? 0);
    }
    return Effect.succeed("OK");
  }
  const fix = /^geo fix (?<lng>\S+) (?<lat>\S+)$/u.exec(line)?.groups;
  if (fix?.lat === undefined || fix.lng === undefined) {
    return undefined;
  }
  device.consoleLocation = {
    latitude: Number(fix.lat),
    longitude: Number(fix.lng),
  };
  return Effect.succeed("OK");
};

const settingsCommand = (
  device: FakeAndroidDevice,
  line: string,
  turn: (rotation: number) => void
): Answer => {
  const get = /^settings get system (?<name>\S+)$/u.exec(line)?.groups?.name;
  if (get === "accelerometer_rotation") {
    return Effect.succeed(device.accelerometerRotation);
  }
  if (get === "user_rotation") {
    return Effect.succeed(device.userRotation);
  }
  const put = /^settings put system (?<name>\S+) (?<value>\S+)$/u.exec(
    line
  )?.groups;
  if (put?.value === undefined) {
    return undefined;
  }
  if (put.name === "accelerometer_rotation") {
    device.accelerometerRotation = put.value;
    return Effect.succeed("");
  }
  if (put.name === "user_rotation") {
    device.userRotation = put.value;
    if (device.accelerometerRotation === "0") {
      turn(Number(put.value));
    }
    return Effect.succeed("");
  }
  return undefined;
};

const shellCommand = (
  device: FakeAndroidDevice,
  line: string,
  display: () => number
): Answer => {
  if (line === "cmd uimode night") {
    return Effect.succeed(`Night mode: ${device.nightMode}`);
  }
  const night = /^cmd uimode night (?<mode>yes|no|auto)$/u.exec(line)?.groups
    ?.mode;
  if (night === "yes" || night === "no" || night === "auto") {
    device.nightMode = night;
    return Effect.succeed(`Night mode: ${night}`);
  }
  if (line === "dumpsys display") {
    return Effect.succeed(`  mCurrentOrientation=${display()}`);
  }
  if (line === "dumpsys location") {
    return Effect.succeed(
      device.gps === null
        ? "      last location=null"
        : `      last location=Location[gps ${device.gps.latitude},${device.gps.longitude} hAcc=5.0]`
    );
  }
  return undefined;
};

/**
 * An `adb` that answers the Emulation commands from `device` and logs each
 * call as one line. The display follows `user_rotation` while the rotation
 * lock is on and the emulator's body while it is off, as on a device.
 */
export const fakeAndroidAdb = (
  device: FakeAndroidDevice,
  calls: string[] = []
): AndroidAdb => {
  let display = Number(device.userRotation);
  const turn = (rotation: number) => {
    display = rotation;
  };
  return (serial, args) =>
    Effect.suspend(() => {
      calls.push(`${serial} ${args.join(" ")}`);
      const [first, ...rest] = args;
      const line = rest.join(" ");
      let answer: Answer;
      if (first === "emu") {
        answer = consoleCommand(device, line, turn);
      } else if (first === "shell") {
        answer =
          settingsCommand(device, line, turn) ??
          shellCommand(device, line, () => display);
      }
      return answer ?? Effect.fail(platformRuntimeError("runtime_failed"));
    });
};
