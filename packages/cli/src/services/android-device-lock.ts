import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, Option, Schema } from "effect";

import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/** SQLite's result code when another connection holds the database lock. */
const SQLITE_BUSY = 5;

const SqliteError = Schema.Struct({ errcode: Schema.optional(Schema.Number) });
const sqliteCode = (cause: unknown): number | undefined =>
  Schema.decodeUnknownOption(SqliteError)(cause).pipe(
    Option.flatMap(({ errcode }) => Option.fromNullishOr(errcode)),
    Option.getOrUndefined
  );

const unreadable = (lockPath: string): PlatformRuntimeError => ({
  ...platformRuntimeError("device_lock_held"),
  message: `This Android device's lock at ${lockPath} is not a lock this version of Contingency can take, so it cannot tell whether another process is using the device. If no other Contingency process is using it, delete that path, then start a new Android session.`,
});

export const androidDeviceLockPath = (serial: string): string =>
  path.join(
    tmpdir(),
    `contingency-android-${createHash("sha256").update(serial).digest("hex")}.lock`
  );

export interface AndroidDeviceLock {
  readonly release: Effect.Effect<void, PlatformRuntimeError>;
}

/**
 * Takes the device for this process with an exclusive SQLite transaction on
 * the lock file. The OS releases that lock when the process exits, however it
 * exits, so a lock never outlives its owner and no start reclaims one. The
 * file itself stays: removing it would let a new start lock a different file
 * than a start that already opened the old one.
 */
export const acquireAndroidDeviceLock = (
  lockPath: string
): Effect.Effect<AndroidDeviceLock, PlatformRuntimeError> =>
  Effect.gen(function* acquireLock() {
    yield* Effect.tryPromise({
      catch: () => unreadable(lockPath),
      try: () => writeFile(lockPath, "", { flag: "a", mode: 0o600 }),
    });
    const database = yield* Effect.try({
      catch: () => unreadable(lockPath),
      try: () => new DatabaseSync(lockPath, { timeout: 0 }),
    });
    yield* Effect.try({
      catch: (cause) => {
        database.close();
        return sqliteCode(cause) === SQLITE_BUSY
          ? platformRuntimeError("device_lock_held")
          : unreadable(lockPath);
      },
      try: () => database.exec("BEGIN EXCLUSIVE"),
    });
    return {
      release: Effect.try({
        catch: () => platformRuntimeError("cleanup_failed"),
        try: () => {
          if (database.isOpen) {
            database.close();
          }
        },
      }),
    };
  });
