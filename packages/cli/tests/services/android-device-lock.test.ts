import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { acquireAndroidDeviceLock } from "../../src/services/android-device-lock.ts";

const holderScript = fileURLToPath(
  new URL("fixtures/hold-android-device-lock.ts", import.meta.url)
);

const lockDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "android-device-lock-"))),
  (directory) =>
    Effect.promise(() => rm(directory, { force: true, recursive: true }))
).pipe(Effect.map((directory) => path.join(directory, "device.lock")));

const kill = (child: ChildProcess) =>
  Effect.promise(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });

/** The holder prints one outcome line. */
const HolderLine = Schema.Tuple([
  Schema.Literals(["held", "refused device_lock_held"]),
]);

interface Holder {
  readonly child: ChildProcess;
  /** The holder's first line: `held`, or `refused <code>`. */
  readonly outcome: string;
}

/** Another process trying the production lock, stopped with the test scope. */
const holder = (lockPath: string) =>
  Effect.acquireRelease(
    Effect.promise(async (): Promise<Holder> => {
      const child = spawn(process.execPath, [holderScript, lockPath], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const lines = createInterface({ input: child.stdout });
      const [outcome] = Schema.decodeUnknownSync(HolderLine)(
        await once(lines, "line")
      );
      return { child, outcome };
    }),
    ({ child }) => kill(child)
  );

it.effect("takes a lock whose owner process was killed", () =>
  Effect.scoped(
    Effect.gen(function* afterKill() {
      const lockPath = yield* lockDirectory;
      const first = yield* holder(lockPath);
      expect(first.outcome).toBe("held");
      yield* kill(first.child);
      const lock = yield* acquireAndroidDeviceLock(lockPath);
      yield* lock.release;
    })
  )
);

it.effect("refuses a lock held by a live process and names the held lock", () =>
  Effect.scoped(
    Effect.gen(function* refuseLive() {
      const lockPath = yield* lockDirectory;
      expect((yield* holder(lockPath)).outcome).toBe("held");
      const failure = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
      expect(failure.code).toBe("device_lock_held");
      expect(failure.message).toContain(
        "Another Contingency process is using this Android device"
      );
      expect(failure.message).not.toContain("helper");
    })
  )
);

it.effect(
  "keeps the lock held when a start in the same process is refused",
  () =>
    Effect.scoped(
      Effect.gen(function* refusedRetry() {
        const lockPath = yield* lockDirectory;
        const lock = yield* acquireAndroidDeviceLock(lockPath);
        expect((yield* holder(lockPath)).outcome).toBe(
          "refused device_lock_held"
        );
        const retry = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
        expect(retry.code).toBe("device_lock_held");
        expect((yield* holder(lockPath)).outcome).toBe(
          "refused device_lock_held"
        );
        yield* lock.release;
        expect((yield* holder(lockPath)).outcome).toBe("held");
      })
    )
);

it.effect("lets exactly one of several processes take the device", () =>
  Effect.scoped(
    Effect.gen(function* raceProcesses() {
      const lockPath = yield* lockDirectory;
      const outcomes = yield* Effect.all(
        [0, 1, 2, 3].map(() => holder(lockPath)),
        { concurrency: "unbounded" }
      );
      expect(outcomes.map(({ outcome }) => outcome).toSorted()).toEqual([
        "held",
        "refused device_lock_held",
        "refused device_lock_held",
        "refused device_lock_held",
      ]);
    })
  )
);

it.effect("lets exactly one start in this process take the device", () =>
  Effect.scoped(
    Effect.gen(function* raceFibers() {
      const lockPath = yield* lockDirectory;
      const results = yield* Effect.all(
        [0, 1, 2].map(() => Effect.result(acquireAndroidDeviceLock(lockPath))),
        { concurrency: "unbounded" }
      );
      const taken = results.flatMap((result) =>
        result._tag === "Success" ? [result.success] : []
      );
      expect(taken).toHaveLength(1);
      for (const result of results) {
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("device_lock_held");
        }
      }
      for (const lock of taken) {
        yield* lock.release;
      }
    })
  )
);

it.effect("releases the lock when a start fails after taking it", () =>
  Effect.scoped(
    Effect.gen(function* failedStart() {
      const lockPath = yield* lockDirectory;
      const started = yield* Effect.exit(
        Effect.gen(function* start() {
          yield* Effect.acquireRelease(
            acquireAndroidDeviceLock(lockPath),
            (lock) => Effect.orDie(lock.release)
          );
          return yield* Effect.fail("helper running");
        }).pipe(Effect.scoped)
      );
      expect(Exit.isFailure(started)).toBe(true);
      expect((yield* holder(lockPath)).outcome).toBe("held");
    })
  )
);

it.effect("refuses an old lock directory and names its path", () =>
  Effect.scoped(
    Effect.gen(function* refuseLegacy() {
      const lockPath = yield* lockDirectory;
      yield* Effect.promise(() => mkdir(lockPath));
      const failure = yield* Effect.flip(acquireAndroidDeviceLock(lockPath));
      expect(failure.code).toBe("device_lock_held");
      expect(failure.message).toContain(lockPath);
    })
  )
);
