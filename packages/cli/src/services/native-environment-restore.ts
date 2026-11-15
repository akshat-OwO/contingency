import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { NativeEmulationChange } from "@contingency/protocol";
import { Effect, Schema, Semaphore } from "effect";

import {
  AndroidDeviceEnvironment,
  applyAndroidEmulationChange,
  readAndroidEnvironment,
  restoreAndroidEnvironment,
} from "./android-emulation.ts";
import type {
  AndroidAdb,
  AndroidDeviceEnvironmentValue,
} from "./android-emulation.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/**
 * What a session found on a user-selected device before it first changed the
 * device's Emulation, saved before that change so a later process can put it
 * back if this one dies first (ADR 0082).
 */
export const AndroidEnvironmentRecord = Schema.Struct({
  avd: Schema.String,
  environment: AndroidDeviceEnvironment,
  pid: Schema.Int,
  platform: Schema.Literal("android"),
  serial: Schema.String,
});
type AndroidEnvironmentRecordValue = typeof AndroidEnvironmentRecord.Type;

const DIRECTORY = ".device-environment";
const recordFile = (root: string, avd: string) =>
  path.join(root, DIRECTORY, `android-${encodeURIComponent(avd)}.json`);

const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => platformRuntimeError("runtime_failed"),
    try: work,
  });

const readRecord = (file: string) =>
  io(() => readFile(file, "utf-8")).pipe(
    Effect.flatMap((contents) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(AndroidEnvironmentRecord)
      )(contents)
    ),
    Effect.option
  );

const writeRecord = (file: string, record: AndroidEnvironmentRecordValue) =>
  io(async () => {
    await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  });

const removeRecord = (file: string) => io(() => rm(file, { force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export interface EmulationGuard {
  /** Changes the device, saving its environment first the first time. */
  readonly change: (
    change: NativeEmulationChange
  ) => Effect.Effect<void, PlatformRuntimeError>;
  /** Puts back what this session found. It never fails a session's end. */
  readonly restore: Effect.Effect<void>;
}

/**
 * One session's guard for one Android device. A device this process booted
 * is not restored: it stops with the process (ADR 0077).
 */
export const makeAndroidEmulationGuard = (input: {
  readonly adb: AndroidAdb;
  readonly root: string;
  readonly serial: string;
  /** Null for a phone, which has no AVD to key a record by. */
  readonly avd: string | null;
  readonly owned: Effect.Effect<boolean>;
}): EmulationGuard => {
  const lock = Semaphore.makeUnsafe(1);
  let saved:
    | {
        readonly file: string | null;
        readonly environment: AndroidDeviceEnvironmentValue;
      }
    | undefined;
  let skip = false;
  const save = Effect.gen(function* saveEnvironment() {
    if (saved !== undefined || skip) {
      return;
    }
    if (yield* input.owned) {
      skip = true;
      return;
    }
    if (input.avd === null) {
      // A phone keeps no record across processes; this session still restores it.
      saved = {
        environment: yield* readAndroidEnvironment(input.adb, input.serial),
        file: null,
      };
      return;
    }
    const file = recordFile(input.root, input.avd);
    // A record a dead process left holds the device's real original.
    const existing = yield* readRecord(file);
    const environment =
      existing._tag === "Some"
        ? existing.value.environment
        : yield* readAndroidEnvironment(input.adb, input.serial);
    yield* writeRecord(file, {
      avd: input.avd,
      environment,
      pid: process.pid,
      platform: "android",
      serial: input.serial,
    });
    saved = { environment, file };
  });
  return {
    change: (change) =>
      lock.withPermits(1)(
        save.pipe(
          Effect.andThen(
            applyAndroidEmulationChange(input.adb, input.serial, change)
          )
        )
      ),
    restore: lock.withPermits(1)(
      Effect.suspend(() => {
        const current = saved;
        if (current === undefined) {
          return Effect.void;
        }
        return restoreAndroidEnvironment(
          input.adb,
          input.serial,
          current.environment
        ).pipe(
          Effect.andThen(
            current.file === null ? Effect.void : removeRecord(current.file)
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              saved = undefined;
            })
          ),
          // A failed restore keeps the record for the next process start.
          Effect.ignore
        );
      })
    ),
  };
};

/**
 * Restores devices a dead process changed and left running. A record whose
 * process lives belongs to that process; one whose device is not booted
 * waits for a later start.
 */
export const restoreLeftoverEnvironments = (input: {
  readonly adb: AndroidAdb;
  readonly root: string;
  /** The AVD a booted emulator serial runs, or null. */
  readonly avdOf: (serial: string) => Effect.Effect<string | null>;
}) =>
  Effect.gen(function* restoreLeftovers() {
    const directory = path.join(input.root, DIRECTORY);
    const names = yield* io(() => readdir(directory)).pipe(
      Effect.orElseSucceed((): string[] => [])
    );
    yield* Effect.forEach(
      names.filter(
        (name) => name.startsWith("android-") && name.endsWith(".json")
      ),
      (name) =>
        Effect.gen(function* restoreOne() {
          const file = path.join(directory, name);
          const record = yield* readRecord(file);
          if (record._tag === "None" || alive(record.value.pid)) {
            return;
          }
          const { avd, environment, serial } = record.value;
          if ((yield* input.avdOf(serial)) !== avd) {
            return;
          }
          yield* restoreAndroidEnvironment(input.adb, serial, environment);
          yield* removeRecord(file);
        }).pipe(Effect.ignore),
      { discard: true }
    );
  });
