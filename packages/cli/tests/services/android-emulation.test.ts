import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  applyAndroidEmulationChange,
  parseDisplayRotation,
  parseGpsLocation,
  parseComputedNight,
  parseNightMode,
  parseSkinTurns,
  readAndroidEmulation,
  readAndroidEnvironment,
  restoreAndroidEnvironment,
} from "../../src/services/android-emulation.ts";
import { emulationChanges } from "../../src/services/native-emulation.ts";
import {
  makeAndroidEmulationGuard,
  restoreLeftoverEnvironments,
} from "../../src/services/native-environment-restore.ts";
import { fakeAndroidAdb, fakeAndroidDevice } from "./fake-android-adb.ts";

const serial = "emulator-5554";

it("parses the device's rotation, night mode, and last GPS fix", () => {
  expect(parseDisplayRotation("    mCurrentOrientation=1\n")).toBe(1);
  expect(parseDisplayRotation("no display")).toBeUndefined();
  expect(parseNightMode("Night mode: yes")).toBe("yes");
  expect(parseNightMode("Night mode: auto")).toBe("auto");
  expect(parseNightMode("unknown")).toBeUndefined();
  expect(parseNightMode("Night mode: custom_schedule")).toBe("custom_schedule");
  expect(parseNightMode("Night mode: custom_bedtime")).toBe("custom_bedtime");
  // Android 11 names one custom schedule.
  expect(parseNightMode("Night mode: custom")).toBe("custom");
  expect(
    parseComputedNight(
      " mWaitForDeviceInactive=false mComputedNightMode=true customStart=22:00"
    )
  ).toBe(true);
  expect(parseComputedNight("mComputedNightMode=false")).toBe(false);
  expect(parseComputedNight("no uimode")).toBeUndefined();
  expect(parseSkinTurns("acceleration = 0:9.81:0")).toBe(0);
  expect(parseSkinTurns("acceleration = -9.81:-1.90735e-06:0")).toBe(1);
  expect(parseSkinTurns("acceleration = -8.57617e-07:-9.81:0")).toBe(2);
  expect(parseSkinTurns("acceleration = 9.81:-1.90735e-06:0")).toBe(3);
  expect(parseSkinTurns("KO: unknown")).toBeUndefined();
  expect(
    parseGpsLocation(
      "      last location=Location[gps 39.237255,-123.150032 hAcc=5.0]"
    )
  ).toEqual({ latitude: 39.237255, longitude: -123.150032 });
  // The fused provider is not the GPS fix an emulator's console sets.
  expect(
    parseGpsLocation("      last location=Location[fused 1.5,2.5 hAcc=5.0]")
  ).toBeNull();
});

it.effect("reads a device's Emulation and applies each change", () =>
  Effect.gen(function* applyChanges() {
    const device = fakeAndroidDevice();
    const adb = fakeAndroidAdb(device);
    expect(yield* readAndroidEmulation(adb, serial)).toEqual({
      appearance: "light",
      location: { latitude: 39.2, longitude: -123.1 },
      orientation: "portrait",
    });
    for (const change of emulationChanges({
      appearance: "dark",
      location: { latitude: 12.97, longitude: 77.59 },
      orientation: "landscape",
    })) {
      yield* applyAndroidEmulationChange(adb, serial, change);
    }
    // An emulator turns its body, so its stream turns too.
    expect(device).toMatchObject({
      accelerometerRotation: "1",
      consoleLocation: { latitude: 12.97, longitude: 77.59 },
      nightMode: "yes",
      skinTurns: 1,
      userRotation: "0",
    });
    expect((yield* readAndroidEmulation(adb, serial)).orientation).toBe(
      "landscape"
    );
  })
);

it.effect("a phone turns its display with the rotation lock", () =>
  Effect.gen(function* rotatePhone() {
    const device = fakeAndroidDevice();
    const calls: string[] = [];
    const adb = fakeAndroidAdb(device, calls);
    const original = yield* readAndroidEnvironment(adb, "R58M123");
    expect(original.skinTurns).toBeNull();
    yield* applyAndroidEmulationChange(adb, "R58M123", {
      _tag: "orientation",
      orientation: "landscape",
    });
    expect(device).toMatchObject({
      accelerometerRotation: "0",
      skinTurns: 0,
      userRotation: "1",
    });
    expect(calls.some((call) => call.includes(" emu "))).toBe(false);
    yield* restoreAndroidEnvironment(adb, "R58M123", original);
    expect(device).toMatchObject({
      accelerometerRotation: "1",
      userRotation: "0",
    });
  })
);

it.effect("restores the rotation lock before the rotation", () =>
  Effect.gen(function* restoreOrder() {
    const device = fakeAndroidDevice({ accelerometerRotation: "0" });
    const calls: string[] = [];
    const adb = fakeAndroidAdb(device, calls);
    const original = yield* readAndroidEnvironment(adb, serial);
    yield* applyAndroidEmulationChange(adb, serial, {
      _tag: "orientation",
      orientation: "landscape",
    });
    calls.length = 0;
    yield* restoreAndroidEnvironment(adb, serial, original);
    const lock = calls.findIndex((call) =>
      call.includes("put system accelerometer_rotation")
    );
    const rotation = calls.findIndex((call) =>
      call.includes("put system user_rotation")
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(rotation);
    expect(device).toMatchObject({
      accelerometerRotation: "0",
      consoleLocation: { latitude: 39.2, longitude: -123.1 },
      nightMode: "no",
      skinTurns: 0,
      userRotation: "0",
    });
  })
);

const withRoot = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "contingency-env-"))),
    use,
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
  );
const records = (root: string) =>
  Effect.promise(() =>
    readdir(path.join(root, ".device-environment")).catch(() => [])
  );

it.effect(
  "saves a selected device's environment before its first change and restores it at the end",
  () =>
    withRoot((root) =>
      Effect.gen(function* guardSelected() {
        const device = fakeAndroidDevice();
        const guard = makeAndroidEmulationGuard({
          adb: fakeAndroidAdb(device),
          avd: "fixture",
          owned: Effect.succeed(false),
          root,
          serial,
        });
        // Nothing changed, nothing saved.
        yield* guard.restore;
        expect(yield* records(root)).toEqual([]);
        yield* guard.change({ _tag: "appearance", appearance: "dark" });
        yield* guard.change({ _tag: "orientation", orientation: "landscape" });
        expect(yield* records(root)).toEqual(["android-fixture.json"]);
        yield* guard.restore;
        expect(device).toMatchObject({
          accelerometerRotation: "1",
          nightMode: "no",
          skinTurns: 0,
          userRotation: "0",
        });
        expect(yield* records(root)).toEqual([]);
      })
    )
);

it.effect("never restores a device this process booted", () =>
  withRoot((root) =>
    Effect.gen(function* guardOwned() {
      const device = fakeAndroidDevice();
      const guard = makeAndroidEmulationGuard({
        adb: fakeAndroidAdb(device),
        avd: "fixture",
        owned: Effect.succeed(true),
        root,
        serial,
      });
      yield* guard.change({ _tag: "appearance", appearance: "dark" });
      yield* guard.restore;
      expect(device.nightMode).toBe("yes");
      expect(yield* records(root)).toEqual([]);
    })
  )
);

it.effect(
  "a later process restores a booted device a dead process changed",
  () =>
    withRoot((root) =>
      Effect.gen(function* restoreLeftovers() {
        const device = fakeAndroidDevice({ nightMode: "yes" });
        const adb = fakeAndroidAdb(device);
        const directory = path.join(root, ".device-environment");
        const record = (avd: string, pid: number) =>
          Effect.promise(() =>
            writeFile(
              path.join(directory, `android-${avd}.json`),
              JSON.stringify({
                avd,
                environment: {
                  accelerometerRotation: "1",
                  location: null,
                  nightMode: "no",
                  skinTurns: 0,
                  userRotation: "0",
                },
                pid,
                platform: "android",
                serial,
              })
            )
          );
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        // A process that still runs owns its record.
        yield* record("live", process.pid);
        // Pid 2^31-1 is never a running process.
        yield* record("fixture", 2_147_483_647);
        yield* record("elsewhere", 2_147_483_647);
        yield* restoreLeftoverEnvironments({
          adb,
          avdOf: () => Effect.succeed("fixture"),
          root,
        });
        expect(device.nightMode).toBe("no");
        expect((yield* records(root)).toSorted()).toEqual([
          "android-elsewhere.json",
          "android-live.json",
        ]);
      })
    )
);

it.effect(
  "a scheduled night mode reads as what the device shows and is restored as a schedule",
  () =>
    withRoot((root) =>
      Effect.gen(function* scheduledNight() {
        // Android 11's custom schedule and a later bedtime schedule, each
        // dark right now.
        for (const policy of ["custom", "custom_bedtime"] as const) {
          const device = fakeAndroidDevice({
            nightMode: policy,
            scheduledDark: true,
          });
          const adb = fakeAndroidAdb(device);
          expect((yield* readAndroidEmulation(adb, serial)).appearance).toBe(
            "dark"
          );
          const guard = makeAndroidEmulationGuard({
            adb,
            avd: "fixture",
            owned: Effect.succeed(false),
            root,
            serial,
          });
          yield* guard.change({ _tag: "appearance", appearance: "light" });
          expect(device.nightMode).toBe("no");
          expect((yield* readAndroidEmulation(adb, serial)).appearance).toBe(
            "light"
          );
          yield* guard.restore;
          expect(device.nightMode).toBe(policy);
        }
        // Automatic mode is light while its schedule says so.
        const automatic = fakeAndroidDevice({ nightMode: "auto" });
        expect(
          (yield* readAndroidEmulation(fakeAndroidAdb(automatic), serial))
            .appearance
        ).toBe("light");
      })
    )
);

it.effect(
  "a session changes a device only after startup recovery is done with it",
  () =>
    withRoot((root) =>
      Effect.gen(function* recoveryFirst() {
        const device = fakeAndroidDevice({ nightMode: "yes" });
        const adb = fakeAndroidAdb(device);
        const directory = path.join(root, ".device-environment");
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        // A dead process left the device dark; it was light before.
        yield* Effect.promise(() =>
          writeFile(
            path.join(directory, "android-fixture.json"),
            JSON.stringify({
              avd: "fixture",
              environment: {
                accelerometerRotation: "1",
                location: null,
                nightMode: "no",
                skinTurns: 0,
                userRotation: "0",
              },
              pid: 2_147_483_647,
              platform: "android",
              serial,
            })
          )
        );
        const lookup = yield* Deferred.make<boolean>();
        const reading = yield* Deferred.make<boolean>();
        const waiting = yield* Deferred.make<boolean>();
        const recovery = yield* Effect.forkChild(
          restoreLeftoverEnvironments({
            adb,
            // Recovery has read the dead process's record by the time it asks.
            avdOf: () =>
              Deferred.succeed(reading, true).pipe(
                Effect.andThen(Deferred.await(lookup)),
                Effect.as("fixture")
              ),
            root,
          })
        );
        yield* Deferred.await(reading);
        const guard = makeAndroidEmulationGuard({
          adb,
          avd: "fixture",
          owned: Effect.succeed(false),
          recovered: Deferred.succeed(waiting, true).pipe(
            Effect.andThen(Fiber.join(recovery))
          ),
          root,
          serial,
        });
        const change = yield* Effect.forkChild(
          guard.change({ _tag: "appearance", appearance: "dark" })
        );
        // The session waits for recovery before it reads or writes anything.
        yield* Deferred.await(waiting);
        expect(device.nightMode).toBe("yes");
        expect(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(path.join(directory, "android-fixture.json"), "utf-8")
            )
          )
        ).toMatchObject({ pid: 2_147_483_647 });
        yield* Deferred.succeed(lookup, true);
        yield* Fiber.join(change);
        expect(device.nightMode).toBe("yes");
        // The session's own record holds the original recovery put back.
        const record = JSON.parse(
          yield* Effect.promise(() =>
            readFile(path.join(directory, "android-fixture.json"), "utf-8")
          )
        );
        expect(record).toMatchObject({
          environment: { nightMode: "no" },
          pid: process.pid,
        });
        yield* guard.restore;
        expect(device.nightMode).toBe("no");
      })
    )
);
