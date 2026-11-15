import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect } from "effect";

import {
  androidRuntimeIo,
  closeAgentDeviceSession,
} from "../../src/services/android-runtime-backend.ts";
import { androidHelperRelease } from "../../src/services/android-runtime-contract.ts";
import {
  ANDROID_RUNTIME_PREFIX,
  reclaimOrphanedAndroidRuntimes,
} from "../../src/services/android-runtime-reclaim.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";

const ownerScript = fileURLToPath(
  new URL("fixtures/own-android-runtime.ts", import.meta.url)
);
const serial = "emulator-5554";

interface Layout {
  readonly root: string;
  readonly claims: string;
}

const layout = Effect.acquireRelease(
  Effect.promise(async (): Promise<Layout> => {
    const base = await mkdtemp(path.join(tmpdir(), "android-runtime-reclaim-"));
    const root = path.join(base, "tmp");
    const claims = path.join(base, "claims");
    await mkdir(root);
    await mkdir(claims);
    return { claims, root };
  }),
  ({ root }) =>
    Effect.promise(() =>
      rm(path.dirname(root), { force: true, recursive: true })
    )
);

const kill = (child: ChildProcess) =>
  Effect.promise(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });

interface Owner {
  readonly child: ChildProcess;
  readonly directory: string;
}

/** Another process that made a runtime directory, stopped with the test scope. */
const owner = ({ claims, root }: Layout, ownerSerial = serial) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<Owner> => {
      const child = spawn(
        process.execPath,
        [ownerScript, root, claims, ownerSerial],
        { stdio: ["pipe", "pipe", "inherit"] }
      );
      const lines = createInterface({ input: child.stdout });
      const [directory] = await once(lines, "line");
      return { child, directory: String(directory) };
    }),
    ({ child }) => kill(child)
  );

const exists = (file: string) =>
  Effect.promise(() =>
    stat(file).then(
      () => true,
      () => false
    )
  );

/** Fake agent-device CLI and ADB that record each call. */
const fakes = (stopFails = false) => {
  const stopped: string[] = [];
  const adbCalls: string[][] = [];
  return {
    adb: (args: readonly string[]) =>
      Effect.sync(() => {
        adbCalls.push([...args]);
        return "";
      }),
    adbCalls,
    stopDaemon: (stateDir: string) =>
      Effect.suspend(() => {
        stopped.push(stateDir);
        return stopFails
          ? Effect.fail(platformRuntimeError("runtime_failed"))
          : Effect.void;
      }),
    stopped,
  };
};

/** Only this test process is alive; every other pid is dead. */
const onlyThisProcess = {
  isAlive: (pid: number) => pid === process.pid,
  startTime: () => Effect.succeed(null),
};

const claim = (stateDir: string, ownerPid: number) =>
  JSON.stringify({
    deviceKey: `local:android:none:${serial}`,
    ownerPid,
    ownerStartTime: null,
    stateDir,
  });

/** A runtime directory a dead process owned, with the given daemon file. */
const deadRuntime = (root: string, name: string, daemonPid?: number) =>
  Effect.promise(async () => {
    const directory = path.join(root, `${ANDROID_RUNTIME_PREFIX}${name}`);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "contingency-owner.json"),
      JSON.stringify({ pid: 999_999, serial, startTime: null })
    );
    if (daemonPid !== undefined) {
      await writeFile(
        path.join(directory, "daemon.json"),
        JSON.stringify({ pid: daemonPid, processStartTime: null })
      );
    }
    return directory;
  });

const forceStop = [
  "shell",
  `am force-stop ${androidHelperRelease.packageName}`,
];

it.effect(
  "reclaims a runtime whose owner process was killed",
  () =>
    Effect.scoped(
      Effect.gen(function* afterKill() {
        const paths = yield* layout;
        const killed = yield* owner(paths);
        yield* kill(killed.child);
        const fake = fakes();
        const reclaimed = yield* reclaimOrphanedAndroidRuntimes({
          adb: fake.adb,
          claimsDirectory: paths.claims,
          root: paths.root,
          serial,
          stopDaemon: fake.stopDaemon,
        });
        expect(reclaimed).toEqual([killed.directory]);
        expect(fake.stopped).toEqual([killed.directory]);
        expect(fake.adbCalls).toEqual([forceStop]);
        expect(yield* exists(killed.directory)).toBe(false);
      })
    ),
  30_000
);

it.effect(
  "leaves a runtime alone while its owner lives or when it names another serial",
  () =>
    Effect.scoped(
      Effect.gen(function* liveOwner() {
        const paths = yield* layout;
        const live = yield* owner(paths);
        const other = yield* owner(paths, "emulator-5556");
        yield* kill(other.child);
        const fake = fakes();
        const reclaimed = yield* reclaimOrphanedAndroidRuntimes({
          adb: fake.adb,
          claimsDirectory: paths.claims,
          root: paths.root,
          serial,
          stopDaemon: fake.stopDaemon,
        });
        expect(reclaimed).toEqual([]);
        expect(fake.stopped).toEqual([]);
        expect(fake.adbCalls).toEqual([]);
        expect(yield* exists(live.directory)).toBe(true);
        expect(yield* exists(other.directory)).toBe(true);
      })
    ),
  30_000
);

it.effect("treats a reused pid as a dead owner", () =>
  Effect.scoped(
    Effect.gen(function* reusedPid() {
      const paths = yield* layout;
      const directory = path.join(
        paths.root,
        `${ANDROID_RUNTIME_PREFIX}reused`
      );
      yield* Effect.promise(async () => {
        await mkdir(directory);
        await writeFile(
          path.join(directory, "contingency-owner.json"),
          JSON.stringify({ pid: process.pid, serial, startTime: "earlier" })
        );
      });
      const fake = fakes();
      const reclaimed = yield* reclaimOrphanedAndroidRuntimes({
        adb: fake.adb,
        claimsDirectory: paths.claims,
        probe: {
          isAlive: () => true,
          startTime: () => Effect.succeed("later"),
        },
        root: paths.root,
        serial,
        stopDaemon: fake.stopDaemon,
      });
      expect(reclaimed).toEqual([directory]);
    })
  )
);

it.effect("reclaims a runtime without an owner file through its claim", () =>
  Effect.scoped(
    Effect.gen(function* legacy() {
      const paths = yield* layout;
      const claimed = path.join(paths.root, `${ANDROID_RUNTIME_PREFIX}legacy`);
      const unclaimed = path.join(paths.root, `${ANDROID_RUNTIME_PREFIX}other`);
      const outside = path.join(path.dirname(paths.root), "user-state");
      yield* Effect.promise(async () => {
        await mkdir(claimed);
        await mkdir(unclaimed);
        await mkdir(outside);
        await writeFile(
          path.join(paths.claims, "a.json"),
          claim(claimed, 999_999)
        );
        await writeFile(
          path.join(paths.claims, "b.json"),
          claim(outside, 999_999)
        );
      });
      const fake = fakes();
      const reclaimed = yield* reclaimOrphanedAndroidRuntimes({
        adb: fake.adb,
        claimsDirectory: paths.claims,
        probe: onlyThisProcess,
        root: paths.root,
        serial,
        stopDaemon: fake.stopDaemon,
      });
      expect(reclaimed).toEqual([claimed]);
      expect(fake.stopped).toEqual([claimed]);
      expect(
        (yield* Effect.promise(() => readdir(paths.root))).toSorted()
      ).toEqual([path.basename(unclaimed)]);
      expect(yield* exists(outside)).toBe(true);
    })
  )
);

it.effect(
  "leaves the helper running while a live external session claims the device",
  () =>
    Effect.scoped(
      Effect.gen(function* liveExternal() {
        const paths = yield* layout;
        const orphan = yield* deadRuntime(paths.root, "dead");
        const external = path.join(path.dirname(paths.root), "external-state");
        yield* Effect.promise(() =>
          writeFile(
            path.join(paths.claims, "external.json"),
            claim(external, process.pid)
          )
        );
        const fake = fakes();
        const reclaimed = yield* reclaimOrphanedAndroidRuntimes({
          adb: fake.adb,
          claimsDirectory: paths.claims,
          probe: onlyThisProcess,
          root: paths.root,
          serial,
          stopDaemon: fake.stopDaemon,
        });
        expect(reclaimed).toEqual([orphan]);
        expect(fake.stopped).toEqual([orphan]);
        expect(fake.adbCalls).toEqual([]);
        expect(yield* exists(orphan)).toBe(false);
        expect(yield* exists(path.join(paths.claims, "external.json"))).toBe(
          true
        );
      })
    )
);

it.effect("keeps a runtime whose daemon did not stop and fails the start", () =>
  Effect.scoped(
    Effect.gen(function* stopFailed() {
      const paths = yield* layout;
      const running = yield* deadRuntime(paths.root, "running", process.pid);
      const dead = yield* deadRuntime(paths.root, "dead", 999_999);
      const fake = fakes(true);
      const failure = yield* Effect.flip(
        reclaimOrphanedAndroidRuntimes({
          adb: fake.adb,
          claimsDirectory: paths.claims,
          probe: onlyThisProcess,
          root: paths.root,
          serial,
          stopDaemon: fake.stopDaemon,
        })
      );
      expect(failure.code).toBe("cleanup_failed");
      expect(failure.message).toContain("did not stop");
      expect(fake.stopped.toSorted()).toEqual([dead, running].toSorted());
      expect(fake.adbCalls).toEqual([]);
      expect(yield* exists(path.join(running, "daemon.json"))).toBe(true);
      expect(yield* exists(path.join(running, "contingency-owner.json"))).toBe(
        true
      );
      expect(yield* exists(dead)).toBe(false);
    })
  )
);

it.effect("keeps orphan runtimes when the helper force-stop fails", () =>
  Effect.scoped(
    Effect.gen(function* forceStopFailed() {
      const paths = yield* layout;
      const orphan = yield* deadRuntime(paths.root, "dead", 999_999);
      const fake = fakes();
      const failure = yield* Effect.flip(
        reclaimOrphanedAndroidRuntimes({
          adb: () => Effect.fail(platformRuntimeError("device_disconnected")),
          claimsDirectory: paths.claims,
          probe: onlyThisProcess,
          root: paths.root,
          serial,
          stopDaemon: fake.stopDaemon,
        })
      );
      expect(failure.code).toBe("device_disconnected");
      expect(yield* exists(path.join(orphan, "contingency-owner.json"))).toBe(
        true
      );
      const retry = yield* reclaimOrphanedAndroidRuntimes({
        adb: fake.adb,
        claimsDirectory: paths.claims,
        probe: onlyThisProcess,
        root: paths.root,
        serial,
        stopDaemon: fake.stopDaemon,
      });
      expect(retry).toEqual([orphan]);
      expect(fake.adbCalls).toEqual([forceStop]);
      expect(yield* exists(orphan)).toBe(false);
    })
  )
);

it.effect("names a device another agent-device session holds", () =>
  Effect.gen(function* deviceInUse() {
    const failure = yield* Effect.flip(
      androidRuntimeIo(() =>
        Promise.reject(
          new AppError("DEVICE_IN_USE", "android device is owned by a session")
        )
      )
    );
    expect(failure.code).toBe("device_in_use");
    expect(failure.message).toContain("Another agent-device session");
  })
);

it.effect("closes a session that never opened without a cleanup failure", () =>
  Effect.gen(function* missingSession() {
    yield* closeAgentDeviceSession(() =>
      Promise.reject(new AppError("SESSION_NOT_FOUND", "No active session"))
    );
    const failure = yield* Effect.flip(
      closeAgentDeviceSession(() =>
        Promise.reject(new AppError("COMMAND_FAILED", "Close failed"))
      )
    );
    expect(failure.code).toBe("runtime_failed");
  })
);
