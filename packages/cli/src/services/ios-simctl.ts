import { readdir } from "node:fs/promises";
import path from "node:path";

import { Context, Effect, Schema } from "effect";

import { runChildText } from "./child-process.ts";
import type { RunChildOptions } from "./child-process.ts";
import { iosError, iosFailure } from "./ios-contract.ts";
import type { IosError, IosApp } from "./ios-contract.ts";

/** A host tool's fixed name for the log: `simctl` rather than `xcrun`. */
const toolName = (file: string, args: readonly string[]) =>
  path.basename(file) === "xcrun" && args[0] !== undefined
    ? args[0]
    : path.basename(file);

export const iosCommand = (
  file: string,
  args: readonly string[],
  code: IosError["code"] = "preparation_failed",
  recognize?: RunChildOptions["recognize"]
) =>
  runChildText({
    args,
    child: toolName(file, args),
    command: file,
    recognize,
    timeoutMs: 180_000,
  }).pipe(Effect.mapError((failure) => iosFailure(code, failure)));
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
        catch: (cause) => iosFailure("discovery_failed", cause),
        try: () => readdir(root),
      });
      const apps: IosApp[] = [];
      for (const directory of directories) {
        const parent = path.join(root, directory);
        const entries = yield* Effect.tryPromise({
          catch: (cause) => iosFailure("discovery_failed", cause),
          try: () => readdir(parent),
        });
        for (const entry of entries.filter((name) => name.endsWith(".app"))) {
          apps.push(yield* readApp(path.join(parent, entry)));
        }
      }
      return apps;
    }),
  architecture: () => process.arch,
  device: simctl,
  devices: () => simctl(["list", "devices", "--json"]),
  platform: () => process.platform,
  readApp,
  runtimes: () => simctl(["list", "runtimes", "--json"]),
  terminate: (udid: string, bundleId: string) =>
    runChildText({
      args: ["simctl", "terminate", udid, bundleId],
      child: "simctl",
      command: "xcrun",
      recognize: ({ stderr }) =>
        stderr.includes("found nothing to terminate")
          ? { code: "nothing_to_terminate" }
          : {},
      timeoutMs: 30_000,
    }).pipe(
      Effect.asVoid,
      // An app that is not running is already where terminate leaves it.
      Effect.catchTag("ChildProcessFailure", (failure) =>
        failure.recognized.code === "nothing_to_terminate"
          ? Effect.void
          : Effect.fail(iosFailure("preparation_failed", failure))
      )
    ),
  xcode: () =>
    iosCommand("xcodebuild", ["-version"], "xcode_missing").pipe(Effect.asVoid),
};
export type IosSimctlService = typeof iosSimctlHost;
export class IosSimctl extends Context.Service<IosSimctl, IosSimctlService>()(
  "contingency/IosSimctl"
) {}
