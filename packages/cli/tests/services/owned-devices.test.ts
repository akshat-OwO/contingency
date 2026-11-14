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

it.effect(
  "records an agent's erase request without erasing, and settles it on the user's answer",
  () =>
    Effect.gen(function* eraseRequests() {
      const erased: string[] = [];
      const android = makeAndroidDeviceBoot();
      const devices = makeOwnedDevicesLayer({
        android: {
          ...android,
          erase: (avd: string) =>
            avd === "Pixel_9"
              ? Effect.sync(() => {
                  erased.push(avd);
                  return "emulator-5554";
                })
              : Effect.fail({
                  code: "android_erase_refused" as const,
                  message: `${avd} is running and Contingency did not start it. Stop this device to erase it.`,
                }),
          stopOwned: Effect.succeed([]),
        },
        ios: stubbed(makeIosDeviceBoot(), Effect.succeed([])),
        report: () => Effect.void,
      });
      yield* Effect.gen(function* answer() {
        const owned = yield* OwnedDevices;
        const first = yield* owned.requestErase({
          device: "Pixel_9",
          operationId: "erase-1",
          platform: "android",
        });
        // Repeating the operationId reads the same request.
        expect(
          yield* owned.requestErase({
            device: "Pixel_9",
            operationId: "erase-1",
            platform: "android",
          })
        ).toEqual(first);
        expect(first.status).toBe("pending");
        expect(erased).toEqual([]);
        yield* owned.requestErase({
          device: "Pixel_8",
          operationId: "erase-2",
          platform: "android",
        });
        yield* owned.requestErase({
          device: "Pixel_7",
          operationId: "erase-3",
          platform: "android",
        });
        yield* owned.erase({
          device: "Pixel_9",
          platform: "android",
          requestId: "erase-1",
        });
        yield* Effect.flip(
          owned.erase({
            device: "Pixel_8",
            platform: "android",
            requestId: "erase-2",
          })
        );
        yield* owned.dismissErase("erase-3");
        const { requests } = yield* owned.eraseState;
        expect(
          requests.map(({ device, status }) => ({ device, status }))
        ).toEqual([
          { device: "Pixel_9", status: "erased" },
          { device: "Pixel_8", status: "failed" },
          { device: "Pixel_7", status: "dismissed" },
        ]);
        expect(requests[1]?.message).toMatch(/Stop this device to erase it/u);
        expect(erased).toEqual(["Pixel_9"]);
      }).pipe(Effect.provide(Layer.fresh(devices)));
    })
);
