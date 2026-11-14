import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Deferred, Effect, Semaphore } from "effect";

import type { OwnedDeviceOutcome } from "./android-device-boot.ts";
import { iosError, iosUuid } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import { iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const execute = promisify(execFile);

/** Starting a simulator fails apart from the runtime's codes. */
const bootFailed = {
  _tag: "IosBootError",
  code: "boot_failed",
  message:
    "Could not start the selected simulator. Check its runtime in Xcode, then try again.",
} as const;
const closingFailed = {
  ...bootFailed,
  message: "Contingency is closing.",
} as const;
const eraseFailed = {
  ...bootFailed,
  message: "Could not erase the selected simulator. Nothing else was changed.",
} as const;
const eraseRefused = (name: string) =>
  ({
    _tag: "IosBootError",
    code: "erase_refused",
    message: `${name} is running and Contingency did not start it. Stop this device to erase it.`,
  }) as const;

export interface IosBootHost {
  readonly simctl: IosSimctlService;
  /**
   * The pid of the `launchd_sim` serving this simulator, absent while it is
   * shut down. A new boot of the same UDID gets a new pid, which is what tells
   * a simulator this process booted from a later one it did not.
   */
  readonly simulatorProcess: (
    udid: string
  ) => Effect.Effect<number | undefined, IosProcessTableError>;
}
export interface IosProcessTableError {
  readonly _tag: "IosProcessTableError";
}

/** Reads the simulator's `launchd_sim` from the process table. */
export const readSimulatorProcess = (table: string, udid: string) => {
  const line = table
    .split(/\r?\n/u)
    .find(
      (entry) =>
        entry.includes("launchd_sim") && entry.includes(`/Devices/${udid}/`)
    );
  const pid = Number(line?.trim().split(/\s+/u)[0] ?? Number.NaN);
  return Number.isInteger(pid) ? pid : undefined;
};

export const iosBootHost: IosBootHost = {
  simctl: iosSimctlHost,
  simulatorProcess: (udid) =>
    Effect.tryPromise({
      catch: (): IosProcessTableError => ({ _tag: "IosProcessTableError" }),
      try: (signal) =>
        execute("/bin/ps", ["-A", "-o", "pid=,command="], {
          maxBuffer: 16 * 1024 * 1024,
          signal,
          timeout: 10_000,
        }),
    }).pipe(Effect.map(({ stdout }) => readSimulatorProcess(stdout, udid))),
};

/**
 * Boots existing matrix simulators by UDID and stops, when the process
 * closes, exactly the boots it issued. It never creates or clones a
 * simulator, erases one only for a Device Erase the user allowed in Workspace
 * (ADR 0081), and never opens Simulator.app: Workspace is the simulator's
 * only window.
 */
export const makeIosDeviceBoot = (host: IosBootHost = iosBootHost) => {
  const discovery = makeIosDiscovery(host.simctl);
  /** Simulators this process booted, by UDID, with the boot's own process. */
  const owned = new Map<
    string,
    { readonly name: string; readonly process: number | undefined }
  >();
  const closed = Deferred.makeUnsafe<readonly OwnedDeviceOutcome[]>();
  let closing = false;
  const booting = Semaphore.makeUnsafe(1);
  const stateOf = (udid: string) =>
    discovery
      .devices()
      .pipe(
        Effect.map((devices) => devices.find((entry) => entry.udid === udid))
      );
  /**
   * Reads the state and issues `simctl boot` under one permit, so overlapping
   * starts cannot both boot the simulator, and records the boot before the
   * permit is released. A simulator already booting or booted, by anyone,
   * is waited on and never owned.
   */
  const claim = (udid: string) =>
    Semaphore.withPermits(
      booting,
      1
    )(
      Effect.gen(function* claimBoot() {
        if (closing) {
          return yield* Effect.fail(closingFailed);
        }
        const entry = yield* stateOf(udid);
        if (entry === undefined) {
          return yield* Effect.fail(iosError("device_mismatch"));
        }
        if (entry.state === "Shutdown") {
          yield* Effect.uninterruptible(
            host.simctl.device(["boot", udid]).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  // Booted elsewhere since the read: wait on it, unowned.
                  stateOf(udid).pipe(
                    Effect.flatMap((now) =>
                      now === undefined || now.state === "Shutdown"
                        ? Effect.fail(bootFailed)
                        : Effect.void
                    )
                  ),
                onSuccess: () =>
                  // Owned either way; without a pid, closing reports it.
                  Effect.result(host.simulatorProcess(udid)).pipe(
                    Effect.map((read) =>
                      owned.set(udid, {
                        name: entry.name,
                        process:
                          read._tag === "Success" ? read.success : undefined,
                      })
                    ),
                    Effect.asVoid
                  ),
              })
            )
          );
        }
        const { state: _state, ...device } = entry;
        return device;
      })
    );
  const boot = (udid: string) =>
    Effect.gen(function* bootSimulator() {
      if (!iosUuid.test(udid)) {
        return yield* Effect.fail(iosError("device_mismatch"));
      }
      const device = yield* claim(udid);
      // `bootstatus` waits whether the boot was ours or already in progress.
      yield* host.simctl
        .device(["bootstatus", udid])
        .pipe(Effect.mapError(() => bootFailed));
      return device;
    });
  const stop = (
    udid: string,
    {
      name,
      process,
    }: { readonly name: string; readonly process: number | undefined }
  ) =>
    Effect.gen(function* stopSimulator() {
      const read = yield* Effect.result(host.simulatorProcess(udid));
      if (read._tag === "Failure") {
        return {
          device: name,
          platform: "ios",
          retained: "Contingency could not read the process table.",
        } satisfies OwnedDeviceOutcome;
      }
      const current = read.success;
      if (current === undefined) {
        return { device: name, platform: "ios" } satisfies OwnedDeviceOutcome;
      }
      if (process === undefined) {
        return {
          device: name,
          platform: "ios",
          retained:
            "Contingency could not confirm it is the simulator it started.",
        } satisfies OwnedDeviceOutcome;
      }
      if (current !== process) {
        // Shut down and booted again by someone else: no longer ours.
        return;
      }
      return yield* host.simctl.device(["shutdown", udid]).pipe(
        Effect.match({
          onFailure: (): OwnedDeviceOutcome => ({
            device: name,
            platform: "ios",
            retained: "`simctl shutdown` failed.",
          }),
          onSuccess: (): OwnedDeviceOutcome => ({
            device: name,
            platform: "ios",
          }),
        })
      );
    });
  /**
   * Stops every simulator this process booted, once. Later calls share the
   * first call's outcomes, and no boot starts after the first call.
   */
  const stopOwned = Effect.suspend(() => {
    if (closing) {
      return Deferred.await(closed);
    }
    closing = true;
    return Semaphore.withPermits(
      booting,
      1
    )(Effect.sync(() => [...owned.entries()])).pipe(
      Effect.flatMap((devices) =>
        Effect.forEach(devices, ([udid, entry]) => stop(udid, entry), {
          concurrency: "unbounded",
        })
      ),
      Effect.map((outcomes) =>
        outcomes.filter((outcome) => outcome !== undefined)
      ),
      Effect.flatMap((outcomes) => Deferred.succeed(closed, outcomes)),
      Effect.andThen(Deferred.await(closed))
    );
  });
  /** Whether this process's own boot still serves `udid`. */
  const ownsRunning = (udid: string) =>
    Effect.gen(function* readOwnership() {
      const entry = owned.get(udid);
      if (entry?.process === undefined) {
        return false;
      }
      const read = yield* Effect.result(host.simulatorProcess(udid));
      return read._tag === "Success" && read.success === entry.process;
    });
  /**
   * Device Erase (ADR 0081): `simctl erase` removes every app, account, and
   * piece of data, then the simulator boots as one this process owns. A
   * booted simulator is shut down first only when this process booted it;
   * one anybody else runs is refused, and nothing is shut down or erased.
   */
  const erase = (udid: string) =>
    Effect.gen(function* eraseSimulator() {
      if (!iosUuid.test(udid)) {
        return yield* Effect.fail(iosError("device_mismatch"));
      }
      yield* Semaphore.withPermits(
        booting,
        1
      )(
        Effect.gen(function* shutDownAndErase() {
          if (closing) {
            return yield* Effect.fail(closingFailed);
          }
          const entry = yield* stateOf(udid);
          if (entry === undefined) {
            return yield* Effect.fail(iosError("device_mismatch"));
          }
          if (entry.state !== "Shutdown") {
            if (!(yield* ownsRunning(udid))) {
              return yield* Effect.fail(eraseRefused(entry.name));
            }
            yield* host.simctl
              .device(["shutdown", udid])
              .pipe(Effect.mapError(() => eraseFailed));
            owned.delete(udid);
          }
          yield* host.simctl
            .device(["erase", udid])
            .pipe(Effect.mapError(() => eraseFailed));
        })
      );
      return yield* boot(udid);
    });
  return {
    boot,
    erase,
    /** The simulators this process's own boot still serves. */
    ownedUdids: Effect.suspend(() =>
      Effect.filter([...owned.keys()], (udid) => ownsRunning(udid))
    ).pipe(Effect.orElseSucceed((): readonly string[] => [])),
    stopOwned,
  };
};
