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

/** The fields of an agent-device device claim that name its device, state, and owner. */
const DeviceClaim = Schema.Struct({
  deviceKey: Schema.String,
  ownerPid: Schema.Int.check(Schema.isGreaterThan(0)),
  ownerStartTime: Schema.NullOr(Schema.String),
  stateDir: Schema.String,
});

/** The daemon identity agent-device advertises in its state directory. */
const DaemonInfo = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  processStartTime: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A process identity: a pid and, when known, its start time. */
interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string | null;
}

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
const ownerAlive = (owner: ProcessIdentity, probe: AndroidRuntimeOwnerProbe) =>
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

const listDirectory = (directory: string) =>
  Effect.tryPromise(() => readdir(directory)).pipe(
    Effect.orElseSucceed((): string[] => [])
  );

const readJson = <A>(schema: Schema.Codec<A>, file: string) =>
  readText(file).pipe(
    Effect.flatMap((text) =>
      Option.isSome(text)
        ? decodeJson(schema, text.value)
        : Effect.succeed(Option.none<A>())
    )
  );

/** Every agent-device claim for `serial`, wherever its state lives. */
const serialClaims = (input: ReclaimAndroidRuntimesInput) =>
  Effect.gen(function* readClaims() {
    const deviceKey = `local:android:none:${input.serial}`;
    const claims: (typeof DeviceClaim.Type)[] = [];
    for (const claimFile of yield* listDirectory(input.claimsDirectory)) {
      const claim = claimFile.endsWith(".json")
        ? yield* readJson(
            DeviceClaim,
            path.join(input.claimsDirectory, claimFile)
          )
        : Option.none();
      if (Option.isSome(claim) && claim.value.deviceKey === deviceKey) {
        claims.push({
          ...claim.value,
          stateDir: path.resolve(claim.value.stateDir),
        });
      }
    }
    return claims;
  });

/**
 * An owned directory is an orphan when its owner is dead and names this
 * serial. A directory from before owner files existed counts only when a
 * claim for this serial names it.
 */
const orphanedRuntimes = (
  input: ReclaimAndroidRuntimesInput,
  probe: AndroidRuntimeOwnerProbe
) =>
  Effect.gen(function* findOrphans() {
    const root = path.resolve(input.root);
    const claimed = new Set<string>();
    for (const { stateDir } of yield* serialClaims(input)) {
      if (
        path.dirname(stateDir) === root &&
        path.basename(stateDir).startsWith(ANDROID_RUNTIME_PREFIX)
      ) {
        claimed.add(stateDir);
      }
    }
    const candidates = new Set(claimed);
    for (const entry of yield* listDirectory(root)) {
      if (entry.startsWith(ANDROID_RUNTIME_PREFIX)) {
        candidates.add(path.join(root, entry));
      }
    }
    const orphans: string[] = [];
    for (const directory of candidates) {
      const owner = yield* readJson(
        RuntimeOwner,
        path.join(directory, ANDROID_RUNTIME_OWNER_FILE)
      );
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

/** Whether the daemon a state directory advertises is still running. */
const daemonAlive = (directory: string, probe: AndroidRuntimeOwnerProbe) =>
  Effect.gen(function* isDaemonAlive() {
    const info = yield* readJson(
      DaemonInfo,
      path.join(directory, "daemon.json")
    );
    return Option.isSome(info)
      ? yield* ownerAlive(
          {
            pid: info.value.pid,
            startTime: info.value.processStartTime ?? null,
          },
          probe
        )
      : false;
  });

const daemonStillRunning = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "cleanup_failed",
  message:
    "A Contingency process that exited left an agent-device daemon holding this Android device, and the daemon did not stop. Stop that agent-device daemon, then retry preparation.",
});

/**
 * Reclaims the device from runtimes a killed Contingency process left behind.
 * Call it only under the device lock: the lock proves no live Contingency
 * process uses this serial, so another runtime directory for it is an orphan.
 * A directory whose owner is alive, or that names another serial, is never
 * touched. A daemon that does not stop keeps its directory, so a later start
 * can try again, and fails the start. The helper is force-stopped only when no
 * live agent-device claim holds the serial; a live external session is left
 * for agent-device to refuse. Returns the reclaimed directories.
 */
export const reclaimOrphanedAndroidRuntimes = (
  input: ReclaimAndroidRuntimesInput
): Effect.Effect<readonly string[], PlatformRuntimeError> =>
  Effect.gen(function* reclaim() {
    const probe = input.probe ?? hostOwnerProbe;
    const orphans = yield* orphanedRuntimes(input, probe);
    if (orphans.length === 0) {
      return [];
    }
    // Stopping each daemon frees its claim and helper session; a daemon that
    // already died leaves a dead claim, which agent-device clears itself.
    const stopped: string[] = [];
    for (const directory of orphans) {
      yield* input.stopDaemon(directory).pipe(Effect.ignore);
      if (!(yield* daemonAlive(directory, probe))) {
        stopped.push(directory);
      }
    }
    for (const directory of stopped) {
      yield* Effect.tryPromise(() =>
        rm(directory, { force: true, recursive: true })
      ).pipe(Effect.ignore);
    }
    if (stopped.length < orphans.length) {
      return yield* Effect.fail(daemonStillRunning());
    }
    let held = false;
    for (const claim of yield* serialClaims(input)) {
      if (
        yield* ownerAlive(
          { pid: claim.ownerPid, startTime: claim.ownerStartTime },
          probe
        )
      ) {
        held = true;
      }
    }
    if (!held) {
      // No live session owns the helper, so a running one is the orphan's.
      yield* input.adb([
        "shell",
        `am force-stop ${androidHelperRelease.packageName}`,
      ]);
    }
    return stopped;
  });
