import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { Duration } from "effect";
import { Deferred, Effect, Fiber, Option, Semaphore } from "effect";

import { androidDiscoveryHost } from "./android-discovery.ts";
import type { AndroidDiscoveryError } from "./android-discovery.ts";

export interface AndroidBootError {
  readonly code:
    | "android_avd_unknown"
    | "android_boot_failed"
    | "android_boot_timeout"
    | "android_stop_failed";
  readonly message: string;
}
const bootError = (
  code: AndroidBootError["code"],
  message: string
): AndroidBootError => ({ code, message });

/**
 * A started emulator. `exited` completes with a reason when it stops;
 * `booted` drops what was kept only to explain an early exit. `stop` ends this
 * launch's own process and nothing else, so it can never stop a later
 * emulator for the same AVD or serial; once the process has exited it does
 * nothing.
 */
export interface AndroidEmulatorLaunch {
  readonly booted: Effect.Effect<void>;
  readonly exited: Effect.Effect<string>;
  readonly stop: Effect.Effect<void, AndroidBootError>;
}

/** What closing the process did with one device it had started. */
export interface OwnedDeviceOutcome {
  readonly device: string;
  readonly platform: "android" | "ios";
  /** Absent when the device stopped; otherwise why it is still running. */
  readonly retained?: string;
}
export interface AndroidBootHost {
  readonly adb: (
    args: readonly string[]
  ) => Effect.Effect<string, AndroidDiscoveryError>;
  readonly avds: () => Effect.Effect<string, AndroidDiscoveryError>;
  readonly launch: (
    avd: string
  ) => Effect.Effect<AndroidEmulatorLaunch, AndroidBootError>;
}

const avdPattern = /^[A-Za-z0-9._-]+$/u;
const sdkRoot = () =>
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  path.join(homedir(), "Library/Android/sdk");

/** The emulator's own last error line, which names a missing system image. */
export const emulatorExitReason = (log: string) => {
  const line = log
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .findLast((entry) => /\b(?:PANIC|FATAL|ERROR)\b/u.test(entry));
  return line === undefined
    ? "The emulator exited before it finished starting."
    : line.replace(/^(?:PANIC|FATAL|ERROR)\s*\|?\s*:?\s*/u, "").slice(0, 400);
};

/**
 * Headless: Workspace is the emulator's only window. Rendering is left to the
 * emulator's own GPU choice, so apps draw as they would in a window.
 */
export const emulatorArguments = (avd: string) => ["-avd", avd, "-no-window"];

/**
 * How long an emulator may take to close cleanly before it is killed. A
 * booted emulator closes on SIGTERM within seconds; one still starting
 * ignores it, and has nothing to save.
 */
const STOP_GRACE = "10 seconds";
const KILL_GRACE = "10 seconds";

/**
 * Starts the emulator headless, in its own process group, so a terminal's
 * Ctrl+C reaches Contingency first and Contingency closes its sessions before
 * it stops the emulator. Workspace is the device's only window. Its output
 * goes to an owned temporary log, read only for an exit reason.
 */
const launchEmulator = (avd: string) =>
  Effect.gen(function* launch() {
    const failed = () =>
      bootError("android_boot_failed", "Could not run the Android emulator.");
    const directory = yield* Effect.tryPromise({
      catch: failed,
      try: () => mkdtemp(path.join(tmpdir(), "contingency-emulator-")),
    });
    const logPath = path.join(directory, "emulator.log");
    // Listen from the moment of spawn, so an immediate exit is never missed.
    const { exit: stopped, group } = yield* Effect.tryPromise({
      catch: failed,
      try: async () => {
        const log = await open(logPath, "w", 0o600);
        try {
          const child = spawn(
            path.join(sdkRoot(), "emulator", "emulator"),
            emulatorArguments(avd),
            { detached: true, stdio: ["ignore", log.fd, log.fd] }
          );
          const state = { running: true };
          // `once` listens synchronously, before this function returns.
          const exit = (async () => {
            try {
              await once(child, "exit");
              return "The emulator exited before it finished starting.";
            } catch {
              return "The Android SDK emulator is not installed.";
            } finally {
              state.running = false;
            }
          })();
          child.unref();
          // Wrapped, so awaiting the launch does not await the exit.
          return { exit, group: { pid: child.pid, state } };
        } finally {
          await log.close();
        }
      },
    });
    const removeLog = Effect.promise(() =>
      rm(directory, { force: true, recursive: true })
    );
    const exited = Effect.promise(() => stopped).pipe(
      Effect.flatMap((detail) =>
        Effect.tryPromise(() => readFile(logPath, "utf-8")).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.map((log) =>
            log.trim() === "" ? detail : emulatorExitReason(log)
          )
        )
      ),
      Effect.ensuring(removeLog)
    );
    // Signals only this launch's process group, and only while its leader has
    // not been reaped, so the group id cannot belong to anything else yet.
    const signal = (name: NodeJS.Signals) =>
      Effect.sync(() => {
        if (group.state.running && group.pid !== undefined) {
          try {
            process.kill(-group.pid, name);
          } catch {
            // The group has already gone.
          }
        }
      });
    const settled = (grace: Duration.Input) =>
      Effect.promise(() => stopped).pipe(Effect.timeoutOption(grace));
    const stop = Effect.gen(function* stopEmulator() {
      if (!group.state.running) {
        return;
      }
      yield* signal("SIGTERM");
      if (Option.isSome(yield* settled(STOP_GRACE))) {
        return;
      }
      yield* signal("SIGKILL");
      if (Option.isNone(yield* settled(KILL_GRACE))) {
        return yield* Effect.fail(
          bootError(
            "android_stop_failed",
            `Emulator process ${group.pid ?? "unknown"} did not exit after SIGKILL.`
          )
        );
      }
      // The process may end before the exit watcher gets to remove the log.
    }).pipe(Effect.ensuring(removeLog));
    // Once booted, `booted` removes the log. The
    // emulator keeps writing to the unlinked file; nothing reads it.
    return { booted: removeLog, exited, stop };
  });

export const androidBootHost: AndroidBootHost = {
  adb: androidDiscoveryHost.adb,
  avds: androidDiscoveryHost.avds,
  launch: launchEmulator,
};

/**
 * Boots an existing AVD by name. It never creates, clones, wipes, or resets
 * one: an unknown name is refused before any emulator command.
 */
export const makeAndroidDeviceBoot = (
  io: AndroidBootHost = androidBootHost,
  options: {
    readonly interval?: Duration.Input;
    readonly timeout?: Duration.Input;
  } = {}
) => {
  /**
   * The emulator already serving this AVD, in any adb state, and whether
   * Android on it has finished booting. A starting emulator counts as present.
   */
  const present = (avd: string) =>
    Effect.gen(function* readPresent() {
      const output = yield* io.adb(["devices"]);
      for (const line of output.split(/\r?\n/u).slice(1)) {
        const [serial] = line.trim().split(/\s+/u);
        if (serial === undefined || !serial.startsWith("emulator-")) {
          continue;
        }
        const name = yield* io.adb(["-s", serial, "emu", "avd", "name"]).pipe(
          Effect.map((text) => text.split(/\r?\n/u)[0]?.trim()),
          Effect.orElseSucceed(() => null)
        );
        if (name !== avd) {
          continue;
        }
        const completed = yield* io
          .adb(["-s", serial, "shell", "getprop", "sys.boot_completed"])
          .pipe(Effect.orElseSucceed(() => ""));
        return { booted: completed.trim() === "1", serial };
      }
      return null;
    }).pipe(Effect.orElseSucceed(() => null));
  const ready = (avd: string) =>
    Effect.gen(function* awaitBoot() {
      for (;;) {
        const found = yield* present(avd);
        if (found?.booted === true) {
          return found.serial;
        }
        yield* Effect.sleep(options.interval ?? "1 second");
      }
    });
  /**
   * Emulators this process launched that are still starting, by AVD. Each
   * fiber completes with the emulator's exit reason, so every boot of that
   * AVD shares one process and one wait. A fiber is never interrupted: other
   * boots may be joined to it.
   */
  const launches = new Map<
    string,
    {
      readonly booted: Effect.Effect<void>;
      readonly exit: Fiber.Fiber<string>;
      readonly token: object;
    }
  >();
  /**
   * Every emulator this process launched that has not exited, booted or not.
   * A launch leaves only when its own process exits, so a timed-out or
   * abandoned boot still belongs to this process, and an emulator someone
   * else starts later for the same AVD never does.
   */
  const owned = new Map<
    object,
    { readonly avd: string; readonly stop: AndroidEmulatorLaunch["stop"] }
  >();
  const closed = Deferred.makeUnsafe<readonly OwnedDeviceOutcome[]>();
  let closing = false;
  const launching = Semaphore.makeUnsafe(1);
  const closingError = () =>
    bootError("android_boot_failed", "Contingency is closing.");
  /**
   * Checks and launches under one permit, so overlapping starts of an AVD
   * cannot both see it absent and both spawn an emulator.
   */
  const claim = (avd: string) =>
    Semaphore.withPermits(
      launching,
      1
    )(
      Effect.gen(function* claimLaunch() {
        if (closing) {
          return yield* Effect.fail(closingError());
        }
        const found = yield* present(avd);
        if (found?.booted === true) {
          return { serial: found.serial } as const;
        }
        const current = launches.get(avd)?.exit;
        if (found !== null || current !== undefined) {
          return { launch: current } as const;
        }
        // Spawning and recording ownership are one step: an interruption
        // between them would leave an emulator nobody stops.
        return yield* Effect.uninterruptible(
          Effect.gen(function* launchOwned() {
            const launched = yield* io.launch(avd);
            // Forget only this launch, never a later one for the same AVD.
            const token = { booted: launched.booted };
            owned.set(token, { avd, stop: launched.stop });
            const exit = yield* Effect.forkDetach(
              launched.exited.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    owned.delete(token);
                    if (launches.get(avd)?.token === token) {
                      launches.delete(avd);
                    }
                  })
                )
              )
            );
            launches.set(avd, { booted: launched.booted, exit, token });
            return { launch: exit } as const;
          })
        );
      })
    );
  /**
   * Stops every emulator this process launched, once. Later calls share the
   * first call's outcomes. Taking the launch permit first means a start in
   * progress has recorded its emulator, and no start begins afterwards.
   */
  const stopOwned = Effect.suspend(() => {
    if (closing) {
      return Deferred.await(closed);
    }
    closing = true;
    return Semaphore.withPermits(
      launching,
      1
    )(Effect.sync(() => [...owned.values()])).pipe(
      Effect.flatMap((devices) =>
        Effect.forEach(
          devices,
          ({ avd, stop }) =>
            stop.pipe(
              Effect.match({
                onFailure: (error): OwnedDeviceOutcome => ({
                  device: avd,
                  platform: "android",
                  retained: error.message,
                }),
                onSuccess: (): OwnedDeviceOutcome => ({
                  device: avd,
                  platform: "android",
                }),
              })
            ),
          { concurrency: "unbounded" }
        )
      ),
      Effect.flatMap((outcomes) => Deferred.succeed(closed, outcomes)),
      Effect.andThen(Deferred.await(closed))
    );
  });
  return {
    boot: (avd: string) =>
      Effect.gen(function* bootAvd() {
        const unknown = bootError(
          "android_avd_unknown",
          `No emulator named ${avd} exists. Contingency starts existing emulators only.`
        );
        if (!avdPattern.test(avd)) {
          return yield* Effect.fail(unknown);
        }
        const inventory = yield* io
          .avds()
          .pipe(
            Effect.mapError(() =>
              bootError(
                "android_boot_failed",
                "Could not list emulators. Check the Android SDK emulator package."
              )
            )
          );
        const names = inventory.split(/\r?\n/u).map((name) => name.trim());
        if (!names.includes(avd)) {
          return yield* Effect.fail(unknown);
        }
        const claimed = yield* claim(avd);
        if ("serial" in claimed) {
          return claimed.serial;
        }
        // An emulator already starting, ours or not, is waited on, never
        // launched again.
        const { launch } = claimed;
        const exited =
          launch === undefined
            ? Effect.never
            : Fiber.join(launch).pipe(
                Effect.flatMap((reason) =>
                  Effect.fail(bootError("android_boot_failed", reason))
                )
              );
        const serial = yield* Effect.raceFirst(ready(avd), exited).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout ?? "4 minutes",
            orElse: () =>
              Effect.fail(
                bootError(
                  "android_boot_timeout",
                  `${avd} is still starting. Refresh devices when it has booted.`
                )
              ),
          })
        );
        // Booted: later boots find it through adb, and its early-exit log
        // is no longer needed. Its exit fiber stays, since others may join it.
        const starting = launches.get(avd);
        if (starting !== undefined) {
          launches.delete(avd);
          yield* starting.booted;
        }
        return serial;
      }),
    stopOwned,
  };
};
