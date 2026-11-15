import { execFile } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Option, Schema } from "effect";

import { hostProcessIsAlive } from "./agent-session-resources.ts";
import type { ProcessIsAlive } from "./agent-session-resources.ts";
import { androidHelperRelease } from "./android-runtime-contract.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const execute = promisify(execFile);

/** Exact prefix of each Android backend's private agent-device state directory. */
export const ANDROID_RUNTIME_PREFIX = "contingency-android-runtime-";
/** The file in a runtime directory that names the process that made it. */
export const ANDROID_RUNTIME_OWNER_FILE = "contingency-owner.json";

const RuntimeOwner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  serial: Schema.String,
  startTime: Schema.NullOr(Schema.String),
});
export type AndroidRuntimeOwner = typeof RuntimeOwner.Type;

/** The fields of an agent-device device claim that name its device and state. */
const DeviceClaim = Schema.Struct({
  deviceKey: Schema.String,
  stateDir: Schema.String,
});

const decodeJson = <A>(schema: Schema.Codec<A>, text: string) =>
  Effect.succeed(
    Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text)
  );

const readText = (file: string) =>
  Effect.tryPromise(() => readFile(file, "utf-8")).pipe(Effect.option);

/** `ps` start time, the same identity agent-device records for its claims. */
export const hostProcessStartTime = (
  pid: number
): Effect.Effect<string | null> =>
  Effect.tryPromise(async () => {
    const { stdout } = await execute("ps", [
      "-o",
      "lstart=",
      "-p",
      String(pid),
    ]);
    const startTime = stdout.trim();
    return startTime === "" ? null : startTime;
  }).pipe(Effect.orElseSucceed(() => null));

export interface AndroidRuntimeOwnerProbe {
  readonly isAlive: ProcessIsAlive;
  readonly startTime: (pid: number) => Effect.Effect<string | null>;
}

const hostOwnerProbe: AndroidRuntimeOwnerProbe = {
  isAlive: hostProcessIsAlive,
  startTime: hostProcessStartTime,
};

/** Records this process as the owner of a fresh runtime directory. */
export const writeAndroidRuntimeOwner = (
  directory: string,
  serial: string,
  probe: AndroidRuntimeOwnerProbe = hostOwnerProbe
) =>
  Effect.gen(function* writeOwner() {
    const owner: AndroidRuntimeOwner = {
      pid: process.pid,
      serial,
      startTime: yield* probe.startTime(process.pid),
    };
    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(directory, ANDROID_RUNTIME_OWNER_FILE),
        JSON.stringify(owner),
        { flag: "wx", mode: 0o600 }
      )
    );
  });

/** A live process whose start time differs reused a dead owner's pid. */
const ownerAlive = (
  owner: AndroidRuntimeOwner,
  probe: AndroidRuntimeOwnerProbe
) =>
  Effect.gen(function* isOwnerAlive() {
    if (!probe.isAlive(owner.pid)) {
      return false;
    }
    if (owner.startTime === null) {
      return true;
    }
    const startTime = yield* probe.startTime(owner.pid);
    // An unreadable start time cannot prove the pid was reused.
    return startTime === null || startTime === owner.startTime;
  });

export const defaultAgentDeviceClaimsDirectory = (): string =>
  path.join(homedir(), ".agent-device", "device-claims");

export interface ReclaimAndroidRuntimesInput {
  readonly serial: string;
  /** The directory that holds runtime directories, normally the OS temp directory. */
  readonly root: string;
  /** agent-device's device claim directory. */
  readonly claimsDirectory: string;
  /** Stops the agent-device daemon whose state lives in the given directory. */
  readonly stopDaemon: (
    stateDir: string
  ) => Effect.Effect<unknown, PlatformRuntimeError>;
  /** ADB bound to `serial`. */
  readonly adb: (
    args: readonly string[]
  ) => Effect.Effect<string, PlatformRuntimeError>;
  readonly probe?: AndroidRuntimeOwnerProbe;
}

const symmetricForward =
  /^(?<serial>\S+)\s+tcp:(?<port>\d+)\s+tcp:(?<remote>\d+)$/u;

const listDirectory = (directory: string) =>
  Effect.tryPromise(() => readdir(directory)).pipe(
    Effect.orElseSucceed((): string[] => [])
  );

const readOwner = (directory: string) =>
  readText(path.join(directory, ANDROID_RUNTIME_OWNER_FILE)).pipe(
    Effect.flatMap((text) =>
      Option.isSome(text)
        ? decodeJson(RuntimeOwner, text.value)
        : Effect.succeed(Option.none<AndroidRuntimeOwner>())
    )
  );

/** Runtime directories under `root` that an agent-device claim for `serial` names. */
const claimedRuntimes = (input: ReclaimAndroidRuntimesInput, root: string) =>
  Effect.gen(function* readClaims() {
    const deviceKey = `local:android:none:${input.serial}`;
    const claimed = new Set<string>();
    for (const claimFile of yield* listDirectory(input.claimsDirectory)) {
      const text = claimFile.endsWith(".json")
        ? yield* readText(path.join(input.claimsDirectory, claimFile))
        : Option.none<string>();
      const claim = Option.isSome(text)
        ? yield* decodeJson(DeviceClaim, text.value)
        : Option.none();
      if (Option.isSome(claim) && claim.value.deviceKey === deviceKey) {
        const directory = path.resolve(claim.value.stateDir);
        if (
          path.dirname(directory) === root &&
          path.basename(directory).startsWith(ANDROID_RUNTIME_PREFIX)
        ) {
          claimed.add(directory);
        }
      }
    }
    return claimed;
  });

/**
 * An owned directory is an orphan when its owner is dead and names this
 * serial. A directory from before owner files existed counts only when a
 * claim for this serial names it.
 */
const orphanedRuntimes = (input: ReclaimAndroidRuntimesInput) =>
  Effect.gen(function* findOrphans() {
    const probe = input.probe ?? hostOwnerProbe;
    const root = path.resolve(input.root);
    const claimed = yield* claimedRuntimes(input, root);
    const candidates = new Set(claimed);
    for (const entry of yield* listDirectory(root)) {
      if (entry.startsWith(ANDROID_RUNTIME_PREFIX)) {
        candidates.add(path.join(root, entry));
      }
    }
    const orphans: string[] = [];
    for (const directory of candidates) {
      const owner = yield* readOwner(directory);
      const orphan = Option.isNone(owner)
        ? claimed.has(directory)
        : owner.value.serial === input.serial &&
          !(yield* ownerAlive(owner.value, probe));
      if (orphan) {
        orphans.push(directory);
      }
    }
    return orphans;
  });

const releaseOrphans = (
  input: ReclaimAndroidRuntimesInput,
  orphans: readonly string[]
) =>
  Effect.gen(function* release() {
    // Stopping each daemon frees its claim and helper session; a daemon that
    // already died leaves a dead claim, which agent-device clears itself.
    for (const directory of orphans) {
      yield* input.stopDaemon(directory).pipe(Effect.ignore);
    }
    yield* input.adb([
      "shell",
      `am force-stop ${androidHelperRelease.packageName}`,
    ]);
    // The helper session forwards one host port to the same device port.
    const forwards = yield* input.adb(["forward", "--list"]);
    for (const line of forwards.split("\n")) {
      const match = symmetricForward.exec(line.trim())?.groups;
      if (match?.serial === input.serial && match.port === match.remote) {
        yield* input.adb(["forward", "--remove", `tcp:${match.port}`]);
      }
    }
    for (const directory of orphans) {
      yield* Effect.tryPromise(() =>
        rm(directory, { force: true, recursive: true })
      ).pipe(Effect.ignore);
    }
  });

/**
 * Reclaims the device from runtimes a killed Contingency process left behind.
 * Call it only under the device lock: the lock proves no live Contingency
 * process uses this serial, so another runtime directory for it is an orphan.
 * A directory whose owner is alive, or that names another serial, is never
 * touched. Returns the reclaimed directories.
 */
export const reclaimOrphanedAndroidRuntimes = (
  input: ReclaimAndroidRuntimesInput
): Effect.Effect<readonly string[], PlatformRuntimeError> =>
  Effect.gen(function* reclaim() {
    const orphans = yield* orphanedRuntimes(input);
    if (orphans.length > 0) {
      yield* releaseOrphans(input, orphans);
    }
    return orphans;
  });
