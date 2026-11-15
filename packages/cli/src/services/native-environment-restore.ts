import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { NativeAppearance, NativeOrientation } from "@contingency/protocol";
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
import {
  clearIosLocation,
  readIosAppearance,
  setIosAppearance,
  setIosLocation,
} from "./ios-emulation.ts";
import type { IosSimctlCommand } from "./ios-emulation.ts";
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

const DIRECTORY = ".device-environment";
/** One record per device: an emulator by its AVD, a simulator by its UDID. */
const recordFile = (root: string, platform: "android" | "ios", key: string) =>
  path.join(root, DIRECTORY, `${platform}-${encodeURIComponent(key)}.json`);

const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => platformRuntimeError("runtime_failed"),
    try: work,
  });

const readRecord = <A, I>(file: string, schema: Schema.Codec<A, I>) =>
  io(() => readFile(file, "utf-8")).pipe(
    Effect.flatMap((contents) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents)
    ),
    Effect.option
  );

const writeRecord = (
  file: string,
  record:
    | typeof AndroidEnvironmentRecord.Type
    | typeof IosEnvironmentRecord.Type
) =>
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
  /** Settles once startup recovery is done with every device. */
  readonly recovered?: Effect.Effect<void>;
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
    const file = recordFile(input.root, "android", input.avd);
    // A record a dead process left holds the device's real original.
    const existing = yield* readRecord(file, AndroidEnvironmentRecord);
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
        (input.recovered ?? Effect.void).pipe(
          Effect.andThen(save),
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
          const record = yield* readRecord(file, AndroidEnvironmentRecord);
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

/**
 * What an iOS session found before its first change of each kind. simctl
 * reads the appearance; the orientation comes from the session's screen.
 * simctl cannot read a simulated location, so a session that set one clears
 * it at the end. A field stays null until the session changes it.
 */
export const IosDeviceEnvironment = Schema.Struct({
  appearance: Schema.NullOr(NativeAppearance),
  location: Schema.Boolean,
  orientation: Schema.NullOr(NativeOrientation),
});
type IosDeviceEnvironmentValue = typeof IosDeviceEnvironment.Type;
export const IosEnvironmentRecord = Schema.Struct({
  environment: IosDeviceEnvironment,
  pid: Schema.Int,
  platform: Schema.Literal("ios"),
  udid: Schema.String,
});

const untouched: IosDeviceEnvironmentValue = {
  appearance: null,
  location: false,
  orientation: null,
};

/** Puts back what simctl can: the appearance, and no simulated location. */
const restoreIosSettings = (
  simctl: IosSimctlCommand,
  udid: string,
  environment: IosDeviceEnvironmentValue
) =>
  Effect.gen(function* restoreSettings() {
    if (environment.appearance !== null) {
      yield* setIosAppearance(simctl, udid, environment.appearance);
    }
    if (environment.location) {
      yield* clearIosLocation(simctl, udid);
    }
  });

const applyIosChange = (
  input: {
    readonly simctl: IosSimctlCommand;
    readonly udid: string;
    readonly rotate: (
      orientation: NativeOrientation
    ) => Effect.Effect<void, PlatformRuntimeError>;
  },
  change: NativeEmulationChange
) => {
  // All change variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (change._tag) {
    case "orientation": {
      return input.rotate(change.orientation);
    }
    case "appearance": {
      return setIosAppearance(input.simctl, input.udid, change.appearance);
    }
    case "location": {
      return setIosLocation(input.simctl, input.udid, change);
    }
  }
};

/**
 * One session's guard for one iOS simulator. Rotation needs the session's
 * agent-device runtime, so the session turns the device back before it
 * closes that runtime; a later process restores the appearance and location
 * a dead one left, never the orientation. A simulator this process booted is
 * not restored: it stops with the process (ADR 0077).
 */
export const makeIosEmulationGuard = (input: {
  readonly simctl: IosSimctlCommand;
  readonly root: string;
  readonly udid: string;
  readonly owned: Effect.Effect<boolean>;
  /** Which way up the device is before the session turns it. */
  readonly orientation: Effect.Effect<NativeOrientation, PlatformRuntimeError>;
  readonly rotate: (
    orientation: NativeOrientation
  ) => Effect.Effect<void, PlatformRuntimeError>;
  /** Settles once startup recovery is done with every device. */
  readonly recovered?: Effect.Effect<void>;
}): EmulationGuard => {
  const lock = Semaphore.makeUnsafe(1);
  const file = recordFile(input.root, "ios", input.udid);
  let saved: IosDeviceEnvironmentValue | undefined;
  let skip: boolean | undefined;
  const save = (change: NativeEmulationChange) =>
    Effect.gen(function* saveEnvironment() {
      skip ??= yield* input.owned;
      if (skip) {
        return;
      }
      if (saved === undefined) {
        // A record a dead process left holds the device's real original.
        const existing = yield* readRecord(file, IosEnvironmentRecord);
        saved =
          existing._tag === "Some" ? existing.value.environment : untouched;
      }
      const current = saved;
      let next = current;
      if (change._tag === "appearance" && current.appearance === null) {
        next = {
          ...current,
          appearance: yield* readIosAppearance(input.simctl, input.udid),
        };
      } else if (
        change._tag === "orientation" &&
        current.orientation === null
      ) {
        next = { ...current, orientation: yield* input.orientation };
      } else if (change._tag === "location" && !current.location) {
        next = { ...current, location: true };
      }
      if (next !== current) {
        yield* writeRecord(file, {
          environment: next,
          pid: process.pid,
          platform: "ios",
          udid: input.udid,
        });
        saved = next;
      }
    });
  return {
    change: (change) =>
      lock.withPermits(1)(
        (input.recovered ?? Effect.void).pipe(
          Effect.andThen(save(change)),
          Effect.andThen(applyIosChange(input, change))
        )
      ),
    restore: lock.withPermits(1)(
      Effect.suspend(() => {
        const current = saved;
        if (current === undefined) {
          return Effect.void;
        }
        return Effect.gen(function* restoreSimulator() {
          // Turned back first, while the runtime still runs. No later
          // process can turn it, so a failed turn keeps no record.
          if (current.orientation !== null) {
            yield* input.rotate(current.orientation).pipe(
              Effect.tapError(() =>
                Effect.logWarning(
                  "Could not turn the iOS simulator back at the session's end.",
                  { udid: input.udid }
                )
              ),
              Effect.ignore
            );
          }
          yield* restoreIosSettings(input.simctl, input.udid, current);
          yield* removeRecord(file);
          saved = undefined;
        }).pipe(
          // A failed restore keeps the record for the next process start.
          Effect.ignore
        );
      })
    ),
  };
};

/**
 * Restores simulators a dead process changed and left booted: their
 * appearance and simulated location. A record whose process lives belongs
 * to that process; one whose simulator is not booted waits for a later start.
 */
export const restoreLeftoverIosEnvironments = (input: {
  readonly simctl: IosSimctlCommand;
  readonly root: string;
  readonly booted: (udid: string) => Effect.Effect<boolean>;
}) =>
  Effect.gen(function* restoreIosLeftovers() {
    const directory = path.join(input.root, DIRECTORY);
    const names = yield* io(() => readdir(directory)).pipe(
      Effect.orElseSucceed((): string[] => [])
    );
    yield* Effect.forEach(
      names.filter((name) => name.startsWith("ios-") && name.endsWith(".json")),
      (name) =>
        Effect.gen(function* restoreOne() {
          const file = path.join(directory, name);
          const record = yield* readRecord(file, IosEnvironmentRecord);
          if (record._tag === "None" || alive(record.value.pid)) {
            return;
          }
          const { environment, udid } = record.value;
          if (!(yield* input.booted(udid))) {
            return;
          }
          yield* restoreIosSettings(input.simctl, udid, environment);
          if (environment.orientation !== null) {
            yield* Effect.logWarning(
              "A dead process left an iOS simulator turned; its orientation is not restored.",
              { udid }
            );
          }
          yield* removeRecord(file);
        }).pipe(Effect.ignore),
      { discard: true }
    );
  });
