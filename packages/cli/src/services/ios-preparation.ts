import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { iosError, supportsIosPermissions } from "./ios-contract.ts";
import type { IosPreparationInput } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import { openIosRunner, stopIosRunner } from "./ios-runner.ts";
import { iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const fileIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => iosError("preparation_failed"),
    try: run,
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
      yield* io.terminate(udid, app.bundleId);
      // Declared states change only the Target App's entries on the selected simulator.
      for (const { decision, service } of input.environment.permissions ?? []) {
        yield* io.device(["privacy", udid, decision, service, app.bundleId]);
      }
      yield* io.device(["launch", udid, app.bundleId]);
      yield* runner(udid, app.bundleId, directory);
      return {
        device: input.device,
        directory,
        environment: input.environment,
      };
    }),
});
