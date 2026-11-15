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

import type { NativeOrientation } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  parseIosAppearance,
  readIosEmulation,
} from "../../src/services/ios-emulation.ts";
import type { IosSimctlCommand } from "../../src/services/ios-emulation.ts";
import { iosRuntimeError } from "../../src/services/ios-runtime.ts";
import {
  makeIosEmulationGuard,
  restoreLeftoverIosEnvironments,
} from "../../src/services/native-environment-restore.ts";

const udid = "F69D9CE5-20E1-4388-9EBA-27B1782EEF75";

/** What the fake simulator shows and every command it was sent. */
interface FakeSimulator {
  appearance: "light" | "dark";
  calls: string[];
  location: string | null;
  orientation: NativeOrientation;
}

/** A simulator's appearance and simulated location, as simctl sees them. */
const fakeSimulator = (start: { appearance?: "light" | "dark" } = {}) => {
  const device: FakeSimulator = {
    appearance: start.appearance ?? "light",
    calls: [],
    location: null,
    orientation: "portrait",
  };
  const simctl: IosSimctlCommand = (args) =>
    Effect.suspend(() => {
      device.calls.push(args.join(" "));
      const [command, target, verb, value] = args;
      if (target !== udid) {
        return Effect.fail(iosRuntimeError("runtime_failed"));
      }
      if (command === "ui" && verb === "appearance") {
        if (value === "light" || value === "dark") {
          device.appearance = value;
          return Effect.succeed("");
        }
        return Effect.succeed(device.appearance);
      }
      if (command === "location" && verb === "set") {
        device.location = value ?? null;
        return Effect.succeed("");
      }
      if (command === "location" && verb === "clear") {
        device.location = null;
        return Effect.succeed("");
      }
      return Effect.fail(iosRuntimeError("runtime_failed"));
    });
  const rotate = (orientation: NativeOrientation) =>
    Effect.sync(() => {
      device.calls.push(`rotate ${orientation}`);
      device.orientation = orientation;
    });
  return { device, rotate, simctl };
};

const withRoot = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "ios-emulation-"))),
    use,
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
  );
const records = (root: string) =>
  Effect.promise(() =>
    readdir(path.join(root, ".device-environment")).catch(() => [])
  );
const record = (root: string) =>
  Effect.promise(async () =>
    JSON.parse(
      await readFile(
        path.join(root, ".device-environment", `ios-${udid}.json`),
        "utf-8"
      )
    )
  );

it("reads the simulator's appearance from simctl", () => {
  expect(parseIosAppearance("dark\n")).toBe("dark");
  expect(parseIosAppearance("Light")).toBe("light");
  expect(parseIosAppearance("unsupported")).toBeUndefined();
  expect(parseIosAppearance("")).toBeUndefined();
});

it.effect(
  "records the session's own orientation and location beside simctl's appearance",
  () =>
    Effect.gen(function* readsEmulation() {
      const { simctl } = fakeSimulator({ appearance: "dark" });
      expect(
        yield* readIosEmulation({
          location: { latitude: 51.5, longitude: -0.12 },
          orientation: "landscape",
          simctl,
          udid,
        })
      ).toEqual({
        appearance: "dark",
        location: { latitude: 51.5, longitude: -0.12 },
        orientation: "landscape",
      });
    })
);

it.effect(
  "saves each setting before the session first changes it and restores them at the end",
  () =>
    withRoot((root) =>
      Effect.gen(function* guardSelected() {
        const { device, rotate, simctl } = fakeSimulator();
        const guard = makeIosEmulationGuard({
          orientation: Effect.sync(() => device.orientation),
          owned: Effect.succeed(false),
          root,
          rotate,
          simctl,
          udid,
        });
        // Nothing changed, nothing saved.
        yield* guard.restore;
        expect(yield* records(root)).toEqual([]);
        yield* guard.change({ _tag: "appearance", appearance: "dark" });
        expect(yield* record(root)).toMatchObject({
          environment: {
            appearance: "light",
            location: false,
            orientation: null,
          },
          pid: process.pid,
          platform: "ios",
          udid,
        });
        yield* guard.change({ _tag: "orientation", orientation: "landscape" });
        yield* guard.change({
          _tag: "location",
          latitude: 37.33,
          longitude: -122.03,
        });
        expect(device).toMatchObject({
          appearance: "dark",
          location: "37.33,-122.03",
          orientation: "landscape",
        });
        expect((yield* record(root)).environment).toEqual({
          appearance: "light",
          location: true,
          orientation: "portrait",
        });
        yield* guard.restore;
        expect(device).toMatchObject({
          appearance: "light",
          location: null,
          orientation: "portrait",
        });
        expect(yield* records(root)).toEqual([]);
      })
    )
);

it.effect("never restores a simulator this process booted", () =>
  withRoot((root) =>
    Effect.gen(function* guardOwned() {
      const { device, rotate, simctl } = fakeSimulator();
      const guard = makeIosEmulationGuard({
        orientation: Effect.sync(() => device.orientation),
        owned: Effect.succeed(true),
        root,
        rotate,
        simctl,
        udid,
      });
      yield* guard.change({ _tag: "appearance", appearance: "dark" });
      yield* guard.change({ _tag: "orientation", orientation: "landscape" });
      yield* guard.restore;
      expect(device).toMatchObject({
        appearance: "dark",
        orientation: "landscape",
      });
      expect(yield* records(root)).toEqual([]);
    })
  )
);

it.effect(
  "restores the appearance even when the runtime can no longer turn the simulator",
  () =>
    withRoot((root) =>
      Effect.gen(function* rotationLost() {
        const { device, rotate, simctl } = fakeSimulator();
        let closed = false;
        const guard = makeIosEmulationGuard({
          orientation: Effect.sync(() => device.orientation),
          owned: Effect.succeed(false),
          root,
          rotate: (orientation) =>
            closed
              ? Effect.fail(iosRuntimeError("runtime_closed"))
              : rotate(orientation),
          simctl,
          udid,
        });
        yield* guard.change({ _tag: "orientation", orientation: "landscape" });
        yield* guard.change({ _tag: "appearance", appearance: "dark" });
        closed = true;
        yield* guard.restore;
        expect(device).toMatchObject({
          appearance: "light",
          orientation: "landscape",
        });
        // No later process can turn it, so no record is kept for that.
        expect(yield* records(root)).toEqual([]);
      })
    )
);

const leftover = (root: string, pid: number, target = udid) =>
  Effect.promise(async () => {
    const directory = path.join(root, ".device-environment");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `ios-${target}.json`),
      JSON.stringify({
        environment: {
          appearance: "light",
          location: true,
          orientation: "portrait",
        },
        pid,
        platform: "ios",
        udid: target,
      })
    );
  });

it.effect(
  "a later process restores a booted simulator a dead process changed",
  () =>
    withRoot((root) =>
      Effect.gen(function* restoreLeftovers() {
        const { device, simctl } = fakeSimulator({ appearance: "dark" });
        device.location = "1,2";
        // Pid 2^31-1 is never a running process.
        yield* leftover(root, 2_147_483_647);
        // A process that still runs owns its record.
        yield* leftover(
          root,
          process.pid,
          "11111111-2222-3333-4444-555555555555"
        );
        // A simulator that is not booted waits for a later start.
        yield* leftover(
          root,
          2_147_483_647,
          "22222222-2222-3333-4444-555555555555"
        );
        yield* restoreLeftoverIosEnvironments({
          booted: (candidate) =>
            Effect.succeed(
              candidate !== "22222222-2222-3333-4444-555555555555"
            ),
          root,
          simctl,
        });
        expect(device).toMatchObject({ appearance: "light", location: null });
        expect((yield* records(root)).toSorted()).toEqual([
          "ios-11111111-2222-3333-4444-555555555555.json",
          "ios-22222222-2222-3333-4444-555555555555.json",
        ]);
      })
    )
);

it.effect(
  "a session changes a simulator only after startup recovery is done with it",
  () =>
    withRoot((root) =>
      Effect.gen(function* recoveryFirst() {
        const { device, rotate, simctl } = fakeSimulator({
          appearance: "dark",
        });
        // A dead process left the simulator dark; it was light before.
        yield* leftover(root, 2_147_483_647);
        const lookup = yield* Deferred.make<boolean>();
        const reading = yield* Deferred.make<boolean>();
        const waiting = yield* Deferred.make<boolean>();
        const recovery = yield* Effect.forkChild(
          restoreLeftoverIosEnvironments({
            // Recovery has read the dead process's record by the time it asks.
            booted: () =>
              Deferred.succeed(reading, true).pipe(
                Effect.andThen(Deferred.await(lookup))
              ),
            root,
            simctl,
          })
        );
        yield* Deferred.await(reading);
        const guard = makeIosEmulationGuard({
          orientation: Effect.sync(() => device.orientation),
          owned: Effect.succeed(false),
          recovered: Deferred.succeed(waiting, true).pipe(
            Effect.andThen(Fiber.join(recovery))
          ),
          root,
          rotate,
          simctl,
          udid,
        });
        const change = yield* Effect.forkChild(
          guard.change({ _tag: "appearance", appearance: "dark" })
        );
        // The session waits for recovery before it reads or writes anything.
        yield* Deferred.await(waiting);
        expect(device.calls).toEqual([]);
        expect(yield* record(root)).toMatchObject({ pid: 2_147_483_647 });
        yield* Deferred.succeed(lookup, true);
        yield* Fiber.join(change);
        expect(device.appearance).toBe("dark");
        // The session's own record holds the original recovery put back.
        expect(yield* record(root)).toMatchObject({
          environment: { appearance: "light" },
          pid: process.pid,
        });
        yield* guard.restore;
        expect(device.appearance).toBe("light");
      })
    )
);
