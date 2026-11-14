import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Option, Schema, Semaphore } from "effect";

import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";
import { processExists } from "./process-liveness.ts";

const execute = promisify(execFile);

/**
 * The process that holds a device. `startedAt` is the owner's `ps` start time,
 * so a PID the OS reused for another process does not count as the owner. It
 * is empty when `ps` could not read it, and then only the PID is checked.
 */
const LockOwner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Schema.String,
  token: Schema.String.check(Schema.isMinLength(1)),
});
type LockOwnerRecord = typeof LockOwner.Type;
const decodeOwner = Schema.decodeUnknownOption(
  Schema.fromJsonString(LockOwner)
);

const ErrorCode = Schema.Struct({ code: Schema.optional(Schema.String) });
const errorCode = (cause: unknown): string | undefined =>
  Schema.decodeUnknownOption(ErrorCode)(cause).pipe(
    Option.flatMap(({ code }) => Option.fromNullishOr(code)),
    Option.getOrUndefined
  );

/** A filesystem call whose failure keeps only its errno code. */
const fs = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => ({ code: errorCode(cause) }),
    try: operation,
  });

const hostFailure = () =>
  Effect.fail<PlatformRuntimeError>({
    ...platformRuntimeError("runtime_failed"),
    operation: "host-io",
  });

const held = () => Effect.fail(platformRuntimeError("device_lock_held"));

const unreadable = (lockPath: string) =>
  Effect.fail<PlatformRuntimeError>({
    ...platformRuntimeError("device_lock_held"),
    message: `This Android device's lock at ${lockPath} has no readable owner, so Contingency cannot tell whether another process is using the device. If no other Contingency process is using it, delete that path, then start a new Android session.`,
  });

/** `ps` state and start time, or none when `ps` cannot read the process. */
const processStatus = (pid: number) =>
  Effect.tryPromise(() =>
    execute("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], {
      timeout: 10_000,
    })
  ).pipe(
    Effect.map(({ stdout }) => {
      const line = stdout.trim();
      const split = line.search(/\s/u);
      return split === -1
        ? Option.none()
        : Option.some({
            startedAt: line.slice(split).trim(),
            state: line.slice(0, split),
          });
    }),
    Effect.orElseSucceed(() => Option.none())
  );

/**
 * Whether the recorded owner still runs. Only ESRCH, a zombie, or a different
 * start time under the same PID proves it is gone; anything unreadable keeps
 * the lock held.
 */
const ownerAlive = (owner: LockOwnerRecord) =>
  Effect.gen(function* checkOwner() {
    if (!processExists(owner.pid)) {
      return false;
    }
    const status = yield* processStatus(owner.pid);
    if (Option.isNone(status)) {
      return processExists(owner.pid);
    }
    if (status.value.state.startsWith("Z")) {
      return false;
    }
    return owner.startedAt === "" || owner.startedAt === status.value.startedAt;
  });

/**
 * Acquisitions in one process take turns, so two starts here never reclaim the
 * same stale lock at once. Each acquisition is a few filesystem calls.
 */
const acquisitions = Semaphore.makeUnsafe(1);

export const androidDeviceLockPath = (serial: string): string =>
  path.join(
    tmpdir(),
    `contingency-android-${createHash("sha256").update(serial).digest("hex")}.lock`
  );

export interface AndroidDeviceLock {
  /** Removes the lock while it is still this holder's. Never removes another's. */
  readonly release: Effect.Effect<void, PlatformRuntimeError>;
}

/** Publishes the owner record at `lockPath` in one step, or reports EEXIST. */
const publish = (lockPath: string, owner: LockOwnerRecord) =>
  Effect.gen(function* publishOwner() {
    const staged = `${lockPath}.${owner.token}.tmp`;
    yield* fs(() =>
      writeFile(staged, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
    ).pipe(Effect.catch(hostFailure));
    const linked = yield* Effect.result(fs(() => link(staged, lockPath)));
    yield* fs(() => unlink(staged)).pipe(Effect.ignore);
    if (linked._tag === "Success") {
      return true;
    }
    return linked.failure.code === "EEXIST" ? false : yield* hostFailure();
  });

/**
 * Moves a dead owner's lock aside. Another start may reclaim at the same time,
 * so the lock is renamed first and checked afterwards; a lock that turns out
 * to be someone else's is put back and the start is refused.
 */
const reclaim = (lockPath: string, stale: LockOwnerRecord, token: string) =>
  Effect.gen(function* reclaimLock() {
    const aside = `${lockPath}.${token}.stale`;
    const moved = yield* Effect.result(fs(() => rename(lockPath, aside)));
    if (moved._tag === "Failure") {
      return moved.failure.code === "ENOENT" ? true : yield* hostFailure();
    }
    const taken = yield* fs(() => readFile(aside, "utf-8")).pipe(
      Effect.map(decodeOwner),
      Effect.orElseSucceed(() => Option.none<LockOwnerRecord>())
    );
    if (Option.isSome(taken) && taken.value.token === stale.token) {
      yield* fs(() => unlink(aside)).pipe(Effect.catch(hostFailure));
      return true;
    }
    yield* fs(() => link(aside, lockPath)).pipe(Effect.ignore);
    yield* fs(() => unlink(aside)).pipe(Effect.ignore);
    return yield* held();
  });

/**
 * Takes the device for this process. A lock whose owner process is gone is
 * reclaimed; a live owner or an unreadable lock refuses the start.
 */
export const acquireAndroidDeviceLock = (
  lockPath: string
): Effect.Effect<AndroidDeviceLock, PlatformRuntimeError> =>
  Effect.gen(function* acquireLock() {
    const self = yield* processStatus(process.pid);
    const owner: LockOwnerRecord = {
      pid: process.pid,
      startedAt: Option.match(self, {
        onNone: () => "",
        onSome: ({ startedAt }) => startedAt,
      }),
      token: randomUUID(),
    };
    const release = Effect.gen(function* releaseLock() {
      const current = yield* fs(() => readFile(lockPath, "utf-8")).pipe(
        Effect.map(decodeOwner),
        Effect.catch((error) =>
          error.code === "ENOENT"
            ? Effect.succeed(Option.none<LockOwnerRecord>())
            : Effect.fail(platformRuntimeError("cleanup_failed"))
        )
      );
      if (Option.isSome(current) && current.value.token === owner.token) {
        yield* fs(() => unlink(lockPath)).pipe(
          Effect.catch((error) =>
            error.code === "ENOENT"
              ? Effect.void
              : Effect.fail(platformRuntimeError("cleanup_failed"))
          )
        );
      }
    });
    for (const _attempt of [0, 1, 2]) {
      if (yield* publish(lockPath, owner)) {
        return { release };
      }
      const existing = yield* Effect.result(
        fs(() => readFile(lockPath, "utf-8"))
      );
      if (existing._tag === "Failure") {
        if (existing.failure.code === "ENOENT") {
          continue;
        }
        return yield* unreadable(lockPath);
      }
      const recorded = decodeOwner(existing.success);
      if (Option.isNone(recorded)) {
        return yield* unreadable(lockPath);
      }
      if (yield* ownerAlive(recorded.value)) {
        return yield* held();
      }
      yield* reclaim(lockPath, recorded.value, owner.token);
    }
    return yield* held();
  }).pipe(acquisitions.withPermits(1));
