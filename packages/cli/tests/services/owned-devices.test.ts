import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { makeAndroidDeviceBoot } from "../../src/services/android-device-boot.ts";
import type { OwnedDeviceOutcome } from "../../src/services/android-device-boot.ts";
import { makeIosDeviceBoot } from "../../src/services/ios-device-boot.ts";
import {
  describeOutcome,
  makeOwnedDevicesLayer,
  OwnedDevices,
} from "../../src/services/owned-devices.ts";

const stubbed = <T extends { readonly stopOwned: unknown }>(
  base: T,
  stopOwned: Effect.Effect<readonly OwnedDeviceOutcome[]>
): T => ({ ...base, stopOwned });

it.effect(
  "stops owned devices only after the sessions inside the process close",
  () =>
    Effect.gen(function* ordering() {
      const events: string[] = [];
      const devices = makeOwnedDevicesLayer({
        android: stubbed(
          makeAndroidDeviceBoot(),
          Effect.sync(() => {
            events.push("android stopped");
            return [{ device: "Pixel_9", platform: "android" }] as const;
          })
        ),
        ios: stubbed(
          makeIosDeviceBoot(),
          Effect.sync(() => {
            events.push("ios stopped");
            return [
              {
                device: "iPhone 17",
                platform: "ios",
                retained: "`simctl shutdown` failed.",
              },
            ] as const;
          })
        ),
        report: (line) => Effect.sync(() => events.push(line)),
      });
      // A command's sessions live in a scope inside the process services.
      yield* Effect.scoped(
        Effect.gen(function* command() {
          yield* OwnedDevices;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => events.push("sessions closed"))
          );
        })
      ).pipe(Effect.provide(Layer.fresh(devices)));
      expect(events).toEqual([
        "sessions closed",
        "android stopped",
        "ios stopped",
        "Stopped the emulator Pixel_9 that Contingency started.",
        "Left the simulator iPhone 17 running: `simctl shutdown` failed.",
      ]);
    })
);

it("names the device and reason for each outcome", () => {
  expect(describeOutcome({ device: "Pixel_9", platform: "android" })).toBe(
    "Stopped the emulator Pixel_9 that Contingency started."
  );
  expect(
    describeOutcome({
      device: "Pixel_9",
      platform: "android",
      retained: "Emulator process 42 did not exit after SIGKILL.",
    })
  ).toBe(
    "Left the emulator Pixel_9 running: Emulator process 42 did not exit after SIGKILL."
  );
});
