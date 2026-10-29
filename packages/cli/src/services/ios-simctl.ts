import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Context, Effect, Schema } from "effect";

import { iosError } from "./ios-contract.ts";
import type { IosError, IosApp } from "./ios-contract.ts";

const execute = promisify(execFile);
export const iosCommand = (
  file: string,
  args: readonly string[],
  code: IosError["code"] = "preparation_failed"
) =>
  Effect.tryPromise({
    catch: () => iosError(code),
    try: async (signal) => {
      const result = await execute(file, args, {
        maxBuffer: 16 * 1024 * 1024,
        signal,
        timeout: 180_000,
      });
      return result.stdout.trim();
    },
  });
export const decodeIosJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => iosError("discovery_failed"))
  );
const AppInfo = Schema.Struct({
  CFBundleDisplayName: Schema.optional(Schema.String),
  CFBundleIdentifier: Schema.NonEmptyString,
  CFBundleName: Schema.optional(Schema.String),
  CFBundleVersion: Schema.NonEmptyString,
});
const readApp = (bundle: string) =>
  Effect.gen(function* readBundle() {
    const info = yield* decodeIosJson(
      AppInfo,
      yield* iosCommand("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(bundle, "Info.plist"),
      ])
    );
    return {
      build: info.CFBundleVersion,
      bundleId: info.CFBundleIdentifier,
      label:
        info.CFBundleDisplayName ??
        info.CFBundleName ??
        info.CFBundleIdentifier,
      path: bundle,
    } satisfies IosApp;
  });
const simctl = (args: readonly string[]) =>
  iosCommand("xcrun", ["simctl", ...args]);
/** Host inventory is separate from commands bound to a selected device. */
export const iosSimctlHost = {
  // Read installed bundles without starting the selected simulator.
  apps: (dataPath: string) =>
    Effect.gen(function* installedBundles() {
      const root = path.join(dataPath, "Containers/Bundle/Application");
      const directories = yield* Effect.tryPromise({
        catch: () => iosError("discovery_failed"),
        try: () => readdir(root),
      });
      const apps: IosApp[] = [];
      for (const directory of directories) {
        const parent = path.join(root, directory);
        const entries = yield* Effect.tryPromise({
          catch: () => iosError("discovery_failed"),
          try: () => readdir(parent),
        });
        for (const entry of entries.filter((name) => name.endsWith(".app"))) {
          apps.push(yield* readApp(path.join(parent, entry)));
        }
      }
      return apps;
    }),
  device: simctl,
  devices: () => simctl(["list", "devices", "--json"]),
  platform: () => process.platform,
  readApp,
  runtimes: () => simctl(["list", "runtimes", "--json"]),
  terminate: (udid: string, bundleId: string) =>
    Effect.tryPromise({
      catch: () => iosError("preparation_failed"),
      try: async (signal) => {
        try {
          await execute("xcrun", ["simctl", "terminate", udid, bundleId], {
            signal,
            timeout: 30_000,
          });
        } catch (error) {
          const stopped = Schema.Struct({
            stderr: Schema.String,
          });
          if (
            !Schema.is(stopped)(error) ||
            !error.stderr.includes("found nothing to terminate")
          ) {
            throw error;
          }
        }
      },
    }),
  xcode: () =>
    iosCommand("xcodebuild", ["-version"], "xcode_missing").pipe(Effect.asVoid),
};
export type IosSimctlService = typeof iosSimctlHost;
export class IosSimctl extends Context.Service<IosSimctl, IosSimctlService>()(
  "contingency/IosSimctl"
) {}
