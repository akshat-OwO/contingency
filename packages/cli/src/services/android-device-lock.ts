import { createHash, randomUUID } from "node:crypto";
import { link, unlink, writeFile } from "node:fs/promises";
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

const ErrorCode = Schema.Struct({ code: Schema.optional(Schema.String) });
const errorCode = (cause: unknown): string | undefined =>
  Schema.decodeUnknownOption(ErrorCode)(cause).pipe(
    Option.flatMap(({ code }) => Option.fromNullishOr(code)),
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

/** Creates an empty, owner-only file that must not exist yet. */
export type CreateLockFile = (file: string) => Promise<void>;

const createLockFile: CreateLockFile = (file) =>
  writeFile(file, "", { flag: "wx", mode: 0o600 });

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
  lockPath: string,
  createFile: CreateLockFile = createLockFile
): Effect.Effect<AndroidDeviceLock, PlatformRuntimeError> =>
  Effect.gen(function* acquireLock() {
    // Closing any descriptor for the lock file drops every POSIX lock this
    // process holds on it, including another start's. So the file is made
    // under a private name and closed first, then linked into place: nothing
    // but SQLite ever holds a descriptor for the inode at `lockPath`.
    const staged = `${lockPath}.${randomUUID()}.tmp`;
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        catch: () => unreadable(lockPath),
        try: () => createFile(staged),
      }),
      () =>
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => link(staged, lockPath),
        }).pipe(
          Effect.catch((error) =>
            errorCode(error) === "EEXIST"
              ? Effect.void
              : Effect.fail(unreadable(lockPath))
          )
        ),
      () => Effect.ignore(Effect.tryPromise(() => unlink(staged)))
    );
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
