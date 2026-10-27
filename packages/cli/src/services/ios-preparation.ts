import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { iosError, iosUuid } from "./ios-contract.ts";
import type { IosPreparationInput } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import { openIosRunner } from "./ios-runner.ts";
import { makeIosSessionResources } from "./ios-session-resources.ts";
import { iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const fileIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => iosError("preparation_failed"),
    try: run,
  });

export const makeIosPreparation = (
  io: IosSimctlService = iosSimctlHost,
  resources = makeIosSessionResources(undefined, io),
  runner: typeof openIosRunner = openIosRunner
) => ({
  prepare: (input: IosPreparationInput) =>
    Effect.gen(function* prepareSessionSimulator() {
      if (input.requiredCapabilities.includes("private-input")) {
        return yield* Effect.fail(iosError("capability_missing"));
      }
      const discovery = makeIosDiscovery(io);
      yield* discovery.resolve(input.device);
      if (
        input.environment.deviceType !== input.device.deviceType ||
        input.environment.runtimeVersion !== input.device.runtimeVersion
      ) {
        return yield* Effect.fail(iosError("environment_changed"));
      }
      const source =
        input.appPath === undefined
          ? (yield* discovery.apps(input.device)).find(
              (app) => app.bundleId === input.environment.bundleId
            )?.path
          : input.appPath;
      if (
        source === undefined ||
        !path.isAbsolute(source) ||
        !source.endsWith(".app")
      ) {
        return yield* Effect.fail(iosError("preparation_failed"));
      }
      const directory = yield* Effect.acquireRelease(
        fileIo(() => mkdtemp(path.join(tmpdir(), "contingency-ios-"))),
        (owned) =>
          Effect.gen(function* releaseHostDirectory() {
            // Retain daemon state when clone/runner cleanup failed, so startup can retry it.
            if (!(yield* resources.isRecorded(owned))) {
              yield* fileIo(() => rm(owned, { force: true, recursive: true }));
            }
          }).pipe(Effect.orDie)
      );
      const bundle = path.join(directory, "Target.app");
      yield* fileIo(() =>
        cp(source, bundle, { dereference: true, recursive: true })
      );
      const app = yield* io.readApp(bundle);
      if (
        app.bundleId !== input.environment.bundleId ||
        app.build !== input.environment.build
      ) {
        return yield* Effect.fail(iosError("environment_changed"));
      }
      // acquireRelease masks interruption until the record and the deletion finalizer exist.
      const udid = yield* Effect.acquireRelease(
        Effect.gen(function* acquireClone() {
          const clone = (yield* io.device([
            "clone",
            input.device.udid,
            `Contingency ${randomUUID()}`,
          ])).trim();
          if (!iosUuid.test(clone) || clone === input.device.udid) {
            return yield* Effect.fail(iosError("preparation_failed"));
          }
          yield* resources
            .record(clone, process.pid, directory)
            .pipe(
              Effect.onError(() =>
                io.device(["delete", clone]).pipe(Effect.orDie)
              )
            );
          return clone;
        }),
        (clone) => resources.remove(clone).pipe(Effect.orDie)
      );
      // No mutation below this point ever targets the selected simulator.
      yield* io.device(["boot", udid]);
      yield* io.device(["bootstatus", udid, "-b"]);
      // Uninstall before install: simctl install alone preserves the template's app data.
      const installed = yield* discovery.apps({ ...input.device, udid });
      if (installed.some((entry) => entry.bundleId === app.bundleId)) {
        yield* io.device(["uninstall", udid, app.bundleId]);
      }
      yield* io.device(["install", udid, bundle]);
      yield* io.device(["keychain", udid, "reset"]);
      yield* io.device(["privacy", udid, "reset", "all"]);
      yield* runner(udid, app.bundleId, directory);
      return {
        device: { ...input.device, udid },
        environment: input.environment,
      };
    }),
});
