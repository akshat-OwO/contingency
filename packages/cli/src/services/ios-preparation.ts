import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startingDataOf } from "@contingency/protocol";
import { Effect } from "effect";

import { iosError, supportsIosPermissions } from "./ios-contract.ts";
import type { IosEnvironment, IosPreparationInput } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import { openIosRunner, stopIosRunner } from "./ios-runner.ts";
import { iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const fileIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => iosError("preparation_failed"),
    try: run,
  });

/** The folders an installed app's data container starts with. */
const containerFolders = [
  "Documents",
  "Library/Caches",
  "Library/Preferences",
  "tmp",
];

/**
 * Clear Starting Data (ADR 0081). Empties the terminated Target App's data
 * container on the selected simulator and drops its cached preferences. The
 * app stays installed. Keychain items and app-group containers are kept: no
 * simctl command scopes them to one app.
 */
export const clearIosAppData = (
  io: Pick<IosSimctlService, "device">,
  udid: string,
  bundleId: string
) =>
  Effect.gen(function* clearAppData() {
    const container = yield* io.device([
      "get_app_container",
      udid,
      bundleId,
      "data",
    ]);
    // Only this simulator's per-app data containers are ever emptied.
    const expected = `${path.sep}Devices${path.sep}${udid}${path.sep}data${path.sep}Containers${path.sep}Data${path.sep}Application${path.sep}`;
    if (
      !path.isAbsolute(container) ||
      path.normalize(container) !== container ||
      !container.includes(expected) ||
      path.basename(path.dirname(container)) !== "Application"
    ) {
      return yield* Effect.fail(iosError("preparation_failed"));
    }
    // cfprefsd caches the app's preferences; deleting the domain drops them.
    // An app that never wrote preferences has no domain to delete.
    yield* io
      .device(["spawn", udid, "defaults", "delete", bundleId])
      .pipe(Effect.ignore);
    yield* fileIo(async () => {
      const entries = await readdir(container);
      await Promise.all(
        entries.map((entry) =>
          rm(path.join(container, entry), { force: true, recursive: true })
        )
      );
      await Promise.all(
        containerFolders.map((folder) =>
          mkdir(path.join(container, folder), { recursive: true })
        )
      );
    });
  });

/**
 * Stops the Target App, applies its Starting Data and privacy decisions, and
 * launches it again. Never installs or uninstalls.
 */
export const restartIosTargetApp = (
  io: Pick<IosSimctlService, "device" | "terminate">,
  input: {
    readonly udid: string;
    readonly bundleId: string;
    readonly environment: IosEnvironment;
    readonly setup?: IosPreparationInput["setup"];
  }
) =>
  Effect.gen(function* restart() {
    const { bundleId, udid } = input;
    yield* io.terminate(udid, bundleId);
    if (startingDataOf(input.setup ?? {}) === "clear") {
      yield* clearIosAppData(io, udid, bundleId);
    }
    // Declared states change only the Target App's entries on the selected simulator.
    for (const { decision, service } of input.environment.permissions ?? []) {
      yield* io.device(["privacy", udid, decision, service, bundleId]);
    }
    yield* io.device(["launch", udid, bundleId]);
  });

export const makeIosPreparation = (
  io: IosSimctlService = iosSimctlHost,
  runner: typeof openIosRunner = openIosRunner,
  stopRunner: typeof stopIosRunner = stopIosRunner
) => ({
  prepare: (input: IosPreparationInput) =>
    Effect.gen(function* prepareSelectedSimulator() {
      if (!supportsIosPermissions(input.environment)) {
        return yield* Effect.fail(iosError("permission_service_unsupported"));
      }
      const discovery = makeIosDiscovery(io);
      yield* discovery.requireRunning(input.device);
      if (
        input.environment.deviceType !== input.device.deviceType ||
        input.environment.runtimeVersion !== input.device.runtimeVersion
      ) {
        return yield* Effect.fail(iosError("environment_changed"));
      }
      const directory = yield* Effect.acquireRelease(
        fileIo(() => mkdtemp(path.join(tmpdir(), "contingency-ios-"))),
        (owned) =>
          Effect.gen(function* releaseRunnerDirectory() {
            // Keep daemon state available for diagnosis if stopping it fails.
            yield* stopRunner(owned, input.device.udid);
            yield* fileIo(() => rm(owned, { force: true, recursive: true }));
          }).pipe(Effect.orDie)
      );
      let app;
      if (input.appPath === undefined) {
        app = (yield* discovery.apps(input.device)).find(
          (installed) => installed.bundleId === input.environment.bundleId
        );
      } else {
        if (
          !path.isAbsolute(input.appPath) ||
          !input.appPath.endsWith(".app")
        ) {
          return yield* Effect.fail(iosError("preparation_failed"));
        }
        const bundle = path.join(directory, "Target.app");
        yield* fileIo(() =>
          cp(input.appPath ?? "", bundle, {
            dereference: true,
            recursive: true,
          })
        );
        app = yield* io.readApp(bundle);
      }
      if (app === undefined) {
        return yield* Effect.fail(iosError("preparation_failed"));
      }
      if (
        app.bundleId !== input.environment.bundleId ||
        app.build !== input.environment.build
      ) {
        return yield* Effect.fail(iosError("environment_changed"));
      }
      // Recheck the selected device before the first mutation, as Android does.
      yield* discovery.requireRunning(input.device);
      const { udid } = input.device;
      if (input.appPath !== undefined) {
        yield* io.device(["install", udid, app.path]);
        const installed = (yield* discovery.apps(input.device)).find(
          (candidate) => candidate.bundleId === app.bundleId
        );
        if (installed?.build !== input.environment.build) {
          return yield* Effect.fail(iosError("environment_changed"));
        }
      }
      yield* restartIosTargetApp(io, {
        bundleId: app.bundleId,
        environment: input.environment,
        setup: input.setup,
        udid,
      });
      yield* runner(udid, app.bundleId, directory);
      return {
        device: input.device,
        directory,
        environment: input.environment,
      };
    }),
});
