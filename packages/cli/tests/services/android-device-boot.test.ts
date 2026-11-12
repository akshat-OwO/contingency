import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  emulatorExitReason,
  makeAndroidDeviceBoot,
} from "../../src/services/android-device-boot.ts";
import type { AndroidBootHost } from "../../src/services/android-device-boot.ts";

const failure = <A, E extends { readonly code: string }>(
  effect: Effect.Effect<A, E>
) =>
  effect.pipe(
    Effect.flip,
    Effect.map(({ code }) => code)
  );

const host = (options: {
  readonly launched: string[];
  readonly running: () => boolean;
  readonly completed?: () => boolean;
  readonly exited?: Effect.Effect<string>;
}): AndroidBootHost => ({
  adb: (args) =>
    Effect.sync(() => {
      const command = args.join(" ");
      if (command === "devices") {
        return options.running()
          ? "List of devices attached\nemulator-5554\tdevice\n"
          : "List of devices attached\n";
      }
      if (command === "-s emulator-5554 emu avd name") {
        return "Pixel_9\nOK";
      }
      if (command === "-s emulator-5554 shell getprop sys.boot_completed") {
        return (options.completed?.() ?? true) ? "1" : "";
      }
      return "";
    }),
  avds: () => Effect.succeed("Pixel_9\nPixel_8\n"),
  launch: (avd) =>
    Effect.sync(() => {
      options.launched.push(avd);
      return { exited: options.exited ?? Effect.never };
    }),
});

it.effect(
  "refuses an AVD that does not exist before any emulator command",
  () =>
    Effect.gen(function* refuseUnknown() {
      const launched: string[] = [];
      const boot = makeAndroidDeviceBoot(
        host({ launched, running: () => false })
      );
      expect(yield* failure(boot.boot("Pixel_10"))).toBe("android_avd_unknown");
      expect(yield* failure(boot.boot("-wipe-data"))).toBe(
        "android_avd_unknown"
      );
      expect(launched).toEqual([]);
    })
);

it.effect("starts an existing AVD and answers once Android has booted", () =>
  Effect.gen(function* bootExisting() {
    const launched: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({ launched, running: () => launched.length > 0 })
    );
    expect(yield* boot.boot("Pixel_9")).toBe("emulator-5554");
    expect(launched).toEqual(["Pixel_9"]);
  })
);

it.effect("does not launch an AVD that is already running", () =>
  Effect.gen(function* alreadyRunning() {
    const launched: string[] = [];
    const boot = makeAndroidDeviceBoot(host({ launched, running: () => true }));
    expect(yield* boot.boot("Pixel_9")).toBe("emulator-5554");
    expect(launched).toEqual([]);
  })
);

it.effect(
  "reports the emulator's own reason when it exits before booting",
  () =>
    Effect.gen(function* exitsEarly() {
      const launched: string[] = [];
      const boot = makeAndroidDeviceBoot(
        host({
          exited: Effect.succeed("Missing system image for Pixel_9"),
          launched,
          running: () => false,
        })
      );
      const error = yield* Effect.flip(boot.boot("Pixel_9"));
      expect(error).toEqual({
        code: "android_boot_failed",
        message: "Missing system image for Pixel_9",
      });
    })
);

it("reads the last error line from the emulator log", () => {
  expect(
    emulatorExitReason(
      "INFO    | Android emulator version 36\nPANIC: Broken AVD system path. Check your ANDROID_SDK_ROOT value\n"
    )
  ).toBe("Broken AVD system path. Check your ANDROID_SDK_ROOT value");
  expect(
    emulatorExitReason(
      "ERROR   | Unknown AVD name [Pixel_9], use -list-avds to see valid list.\n"
    )
  ).toBe("Unknown AVD name [Pixel_9], use -list-avds to see valid list.");
  expect(emulatorExitReason("INFO | quitting\n")).toBe(
    "The emulator exited before it finished starting."
  );
});

it.effect(
  "waits on an emulator that is still booting instead of launching another",
  () =>
    Effect.gen(function* stillBooting() {
      const launched: string[] = [];
      let completed = false;
      const boot = makeAndroidDeviceBoot(
        host({ completed: () => completed, launched, running: () => true }),
        { interval: "1 second" }
      );
      const waiting = yield* Effect.forkChild(boot.boot("Pixel_9"));
      yield* Effect.yieldNow;
      completed = true;
      // it.effect provides TestClock, so this advances the readiness interval.
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(waiting)).toBe("emulator-5554");
      expect(launched).toEqual([]);
    })
);

it.effect("shares one launch between overlapping starts of the same AVD", () =>
  Effect.gen(function* overlapping() {
    const launched: string[] = [];
    const exit = yield* Deferred.make<string>();
    const boot = makeAndroidDeviceBoot(
      host({ exited: Deferred.await(exit), launched, running: () => false })
    );
    const first = yield* Effect.forkChild(Effect.flip(boot.boot("Pixel_9")));
    const second = yield* Effect.forkChild(Effect.flip(boot.boot("Pixel_9")));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(exit, "Missing system image");
    expect((yield* Fiber.join(first)).message).toBe("Missing system image");
    expect((yield* Fiber.join(second)).message).toBe("Missing system image");
    expect(launched).toEqual(["Pixel_9"]);
  })
);
