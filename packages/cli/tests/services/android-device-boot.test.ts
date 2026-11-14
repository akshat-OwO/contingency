import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  emulatorArguments,
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
  readonly released?: string[];
  readonly stopped?: string[];
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
    Effect.gen(function* launch() {
      options.launched.push(avd);
      // Stopping the launch is what makes its process exit.
      const ended = yield* Deferred.make<string>();
      return {
        booted: Effect.sync(() => options.released?.push(avd)),
        exited: Effect.raceFirst(
          options.exited ?? Effect.never,
          Deferred.await(ended)
        ),
        stop: Effect.gen(function* stop() {
          options.stopped?.push(avd);
          yield* Deferred.succeed(ended, "Stopped");
        }),
      };
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

it.effect(
  "lets every overlapping start succeed once the shared launch boots",
  () =>
    Effect.gen(function* overlappingSuccess() {
      const launched: string[] = [];
      const released: string[] = [];
      let completed = false;
      const boot = makeAndroidDeviceBoot(
        host({
          completed: () => completed,
          launched,
          released,
          running: () => launched.length > 0,
        }),
        { interval: "1 second" }
      );
      const first = yield* Effect.forkChild(boot.boot("Pixel_9"));
      const second = yield* Effect.forkChild(boot.boot("Pixel_9"));
      yield* Effect.yieldNow;
      completed = true;
      // it.effect provides TestClock, so this advances both readiness waits.
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(first)).toBe("emulator-5554");
      expect(yield* Fiber.join(second)).toBe("emulator-5554");
      expect(launched).toEqual(["Pixel_9"]);
      expect(released).toEqual(["Pixel_9"]);
    })
);

it("starts the emulator headless", () => {
  expect(emulatorArguments("Pixel_9")).toEqual([
    "-avd",
    "Pixel_9",
    "-no-window",
  ]);
});

it.effect("stops the emulator it started when the process closes", () =>
  Effect.gen(function* stopsOwned() {
    const launched: string[] = [];
    const stopped: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({ launched, running: () => launched.length > 0, stopped })
    );
    yield* boot.boot("Pixel_9");
    const [first, second] = yield* Effect.all(
      [boot.stopOwned, boot.stopOwned],
      { concurrency: "unbounded" }
    );
    expect(first).toEqual([{ device: "Pixel_9", platform: "android" }]);
    expect(second).toEqual(first);
    expect(stopped).toEqual(["Pixel_9"]);
  })
);

it.effect("never stops an emulator that was already running", () =>
  Effect.gen(function* preservesExisting() {
    const launched: string[] = [];
    const stopped: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({ launched, running: () => true, stopped })
    );
    yield* boot.boot("Pixel_9");
    expect(yield* boot.stopOwned).toEqual([]);
    expect(stopped).toEqual([]);
  })
);

it.effect("never stops an emulator already booting when it was asked", () =>
  Effect.gen(function* preservesBooting() {
    const launched: string[] = [];
    const stopped: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({ completed: () => false, launched, running: () => true, stopped }),
      { interval: "1 second" }
    );
    const waiting = yield* Effect.forkChild(boot.boot("Pixel_9"));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    expect(yield* boot.stopOwned).toEqual([]);
    expect(launched).toEqual([]);
    expect(stopped).toEqual([]);
  })
);

it.effect("keeps a launch whose boot timed out, and stops it on close", () =>
  Effect.gen(function* timedOut() {
    const launched: string[] = [];
    const stopped: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({
        completed: () => false,
        launched,
        running: () => launched.length > 0,
        stopped,
      }),
      { interval: "1 second", timeout: "3 seconds" }
    );
    const waiting = yield* Effect.forkChild(failure(boot.boot("Pixel_9")));
    yield* Effect.yieldNow;
    // it.effect provides TestClock, so this reaches the boot timeout.
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(waiting)).toBe("android_boot_timeout");
    expect(yield* boot.stopOwned).toEqual([
      { device: "Pixel_9", platform: "android" },
    ]);
    expect(stopped).toEqual(["Pixel_9"]);
  })
);

it.effect("stops a launch whose boot was interrupted", () =>
  Effect.gen(function* interrupted() {
    const launched: string[] = [];
    const stopped: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({
        completed: () => false,
        launched,
        running: () => launched.length > 0,
        stopped,
      }),
      { interval: "1 second" }
    );
    const waiting = yield* Effect.forkChild(boot.boot("Pixel_9"));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    yield* boot.stopOwned;
    expect(launched).toEqual(["Pixel_9"]);
    expect(stopped).toEqual(["Pixel_9"]);
  })
);

it.effect(
  "forgets a launch once it exits, so a later emulator is not stopped",
  () =>
    Effect.gen(function* replaced() {
      const launched: string[] = [];
      const stopped: string[] = [];
      const exit = yield* Deferred.make<string>();
      const boot = makeAndroidDeviceBoot(
        host({
          exited: Deferred.await(exit),
          launched,
          running: () => launched.length > 0,
          stopped,
        })
      );
      yield* boot.boot("Pixel_9");
      // The user closes it; another tool starts Pixel_9 again.
      yield* Deferred.succeed(exit, "quit");
      yield* Effect.yieldNow;
      expect(yield* boot.stopOwned).toEqual([]);
      expect(stopped).toEqual([]);
    })
);

it.effect("refuses to start an emulator once the process is closing", () =>
  Effect.gen(function* closing() {
    const launched: string[] = [];
    const boot = makeAndroidDeviceBoot(
      host({ launched, running: () => false })
    );
    yield* boot.stopOwned;
    expect((yield* Effect.flip(boot.boot("Pixel_9"))).message).toBe(
      "Contingency is closing."
    );
    expect(launched).toEqual([]);
  })
);

it.effect("reports an emulator it could not stop as left running", () =>
  Effect.gen(function* stopFails() {
    const launched: string[] = [];
    const io = host({ launched, running: () => launched.length > 0 });
    const boot = makeAndroidDeviceBoot({
      ...io,
      launch: (avd, wipe) =>
        io.launch(avd, wipe).pipe(
          Effect.map((launch) => ({
            ...launch,
            stop: Effect.fail({
              code: "android_stop_failed" as const,
              message: "Emulator process 42 did not exit after SIGKILL.",
            }),
          }))
        ),
    });
    yield* boot.boot("Pixel_9");
    expect(yield* boot.stopOwned).toEqual([
      {
        device: "Pixel_9",
        platform: "android",
        retained: "Emulator process 42 did not exit after SIGKILL.",
      },
    ]);
  })
);
