import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { acquireAndroidDeviceLock } from "../../src/services/android-device-lock.ts";

const execute = promisify(execFile);

const lockDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "android-device-lock-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { force: true, recursive: true }))
).pipe(Effect.map((directory) => path.join(directory, "device.lock")));

/** A separate live process, stopped when the test's scope closes. */
const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    })
);

const pidOf = (child: ChildProcess): number => {
  if (child.pid === undefined) {
    throw new Error("Child process has no PID.");
  }
  return child.pid;
};

const startedAt = (pid: number) =>
  Effect.promise(() =>
    execute("ps", ["-p", String(pid), "-o", "lstart="]).then(({ stdout }) =>
      stdout.trim()
    )
  );

/** The PID of a process that has exited and been reaped. */
const exitedPid = Effect.promise(async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return pidOf(child);
});

const writeOwner = (
  lockPath: string,
  owner: { pid: number; startedAt: string; token: string }
) => Effect.promise(() => writeFile(lockPath, JSON.stringify(owner)));

const exists = (file: string) =>
  Effect.promise(() =>
    access(file).then(
      () => true,
      () => false
    )
  );

it.effect("reclaims a lock whose owner process no longer exists", () =>
  Effect.scoped(
    Effect.gen(function* reclaimDead() {
      const lockPath = yield* lockDirectory;
      const pid = yield* exitedPid;
      yield* writeOwner(lockPath, { pid, startedAt: "", token: "dead" });
      const lock = yield* acquireAndroidDeviceLock(lockPath);
      const owner = JSON.parse(
        yield* Effect.promise(() => readFile(lockPath, "utf-8"))
      );
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).not.toBe("dead");
      yield* lock.release;
      expect(yield* exists(lockPath)).toBe(false);
    })
  )
);

it.effect("refuses a lock held by a live process and names the held lock", () =>
  Effect.scoped(
    Effect.gen(function* refuseLive() {
      const lockPath = yield* lockDirectory;
      const holder = yield* liveProcess;
      const pid = pidOf(holder);
      const owner = { pid, startedAt: yield* startedAt(pid), token: "live" };
      yield* writeOwner(lockPath, owner);
      const failure = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
      expect(failure.code).toBe("device_lock_held");
      expect(failure.message).toContain(
        "Another Contingency process is using this Android device"
      );
      expect(failure.message).not.toContain("helper");
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(lockPath, "utf-8")))
      ).toEqual(owner);
    })
  )
);

it.effect("reclaims a lock whose PID now belongs to a different process", () =>
  Effect.scoped(
    Effect.gen(function* reclaimReused() {
      const lockPath = yield* lockDirectory;
      const pid = pidOf(yield* liveProcess);
      yield* writeOwner(lockPath, {
        pid,
        startedAt: "Mon Jan  1 00:00:00 2001",
        token: "reused",
      });
      const lock = yield* acquireAndroidDeviceLock(lockPath);
      const owner = JSON.parse(
        yield* Effect.promise(() => readFile(lockPath, "utf-8"))
      );
      expect(owner.pid).toBe(process.pid);
      yield* lock.release;
    })
  )
);

it.effect("refuses a malformed or legacy lock instead of reclaiming it", () =>
  Effect.scoped(
    Effect.gen(function* refuseUnreadable() {
      const lockPath = yield* lockDirectory;
      yield* Effect.promise(() => writeFile(lockPath, "not json"));
      const malformed = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
      expect(malformed.code).toBe("device_lock_held");
      expect(malformed.message).toContain(lockPath);
      expect(yield* Effect.promise(() => readFile(lockPath, "utf-8"))).toBe(
        "not json"
      );

      yield* Effect.promise(() => rm(lockPath));
      yield* Effect.promise(() => mkdir(lockPath));
      const legacy = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
      expect(legacy.code).toBe("device_lock_held");
      expect(legacy.message).toContain("has no readable owner");
      expect(yield* exists(lockPath)).toBe(true);
    })
  )
);

it.effect("removes the lock when a start fails after taking it", () =>
  Effect.gen(function* failedStart() {
    const scope = yield* Scope.make();
    const lockPath = yield* lockDirectory.pipe(Scope.provide(scope));
    const started = yield* Effect.exit(
      Effect.gen(function* start() {
        yield* Effect.acquireRelease(
          acquireAndroidDeviceLock(lockPath),
          (lock) => Effect.orDie(lock.release)
        );
        expect(yield* exists(lockPath)).toBe(true);
        return yield* Effect.fail("helper running");
      }).pipe(Effect.scoped)
    );
    expect(Exit.isFailure(started)).toBe(true);
    expect(yield* exists(lockPath)).toBe(false);
    yield* Scope.close(scope, Exit.void);
  })
);

it.effect("lets only one concurrent start take a stale lock", () =>
  Effect.scoped(
    Effect.gen(function* raceReclaim() {
      const lockPath = yield* lockDirectory;
      const pid = yield* exitedPid;
      yield* writeOwner(lockPath, { pid, startedAt: "", token: "dead" });
      const results = yield* Effect.all(
        [0, 1, 2].map(() => Effect.result(acquireAndroidDeviceLock(lockPath))),
        { concurrency: "unbounded" }
      );
      const taken = results.filter((result) => result._tag === "Success");
      expect(taken).toHaveLength(1);
      for (const result of results) {
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("device_lock_held");
        }
      }
    })
  )
);

it.effect("never removes a lock another holder has since taken", () =>
  Effect.scoped(
    Effect.gen(function* keepOthers() {
      const lockPath = yield* lockDirectory;
      const lock = yield* acquireAndroidDeviceLock(lockPath);
      const other = { pid: process.pid, startedAt: "", token: "other" };
      yield* writeOwner(lockPath, other);
      yield* lock.release;
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(lockPath, "utf-8")))
      ).toEqual(other);
    })
  )
);
