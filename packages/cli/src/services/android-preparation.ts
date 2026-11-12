import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";

import { requireAndroidDeviceIdentity } from "./android-device-identity.ts";
import { readLocalApkBadging } from "./android-discovery.ts";
import type { AndroidRunInput } from "./android-run-contract.ts";
import {
  appInstallationRefused,
  platformRuntimeError,
} from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const execute = promisify(execFile);
const buildPattern = /\bversionCode=(?<code>\d+)\b/u;
const apkPattern =
  /^package: name='(?<appId>[^']+)' versionCode='(?<build>\d+)'/mu;

const command = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: () => platformRuntimeError("preparation_failed"),
    try: async (signal) => {
      const result = await execute(file, [...args], {
        maxBuffer: 8 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      return result.stdout.trim();
    },
  });
const adb = (input: AndroidRunInput, args: readonly string[]) =>
  command("adb", ["-s", input.device.serial, ...args]);

const refusalPattern = /\b(?<reason>INSTALL_(?:PARSE_)?FAILED_[A-Z0-9_]+)\b/u;
const OutputSchema = Schema.Struct({
  stderr: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
});

/** Reads `adb install` output: success, or the device's refusal reason. */
export const androidInstallOutcome = (output: string) => {
  const reason = refusalPattern.exec(output)?.groups?.reason;
  if (reason !== undefined) {
    return Effect.fail(appInstallationRefused(reason));
  }
  return /^Success$/mu.test(output) && !/Failure/u.test(output)
    ? Effect.void
    : Effect.fail(platformRuntimeError("preparation_failed"));
};

/**
 * Installs or replaces the Target App with `adb install -r`. A refusal such
 * as a downgrade or a signature mismatch is reported with the device's own
 * reason; nothing is ever uninstalled, since that deletes the app's data.
 */
export const installAndroidApk = (input: AndroidRunInput, apk: string) =>
  Effect.gen(function* install() {
    const output = yield* Effect.tryPromise({
      catch: () => platformRuntimeError("preparation_failed"),
      try: async (signal) => {
        try {
          const result = await execute(
            "adb",
            ["-s", input.device.serial, "install", "--user", "0", "-r", apk],
            { maxBuffer: 8 * 1024 * 1024, signal, timeout: 300_000 }
          );
          return `${result.stdout}\n${result.stderr}`;
        } catch (error) {
          // adb exits non-zero on a refusal; its output carries the reason.
          if (!Schema.is(OutputSchema)(error) || signal.aborted) {
            throw error;
          }
          return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        }
      },
    });
    yield* androidInstallOutcome(output);
  });

/** The installed Target App's build, or null when it is not installed. */
export const readInstalledAndroidBuild = (input: AndroidRunInput) =>
  adb(input, [
    "shell",
    "pm",
    "list",
    "packages",
    "--user",
    "0",
    "--show-versioncode",
    input.targetApp,
  ]).pipe(
    Effect.map(
      (output) =>
        output
          .split(/\r?\n/u)
          .map(
            (line) =>
              /^package:(?<name>\S+) versionCode:(?<code>\d+)$/u.exec(
                line.trim()
              )?.groups
          )
          .find((entry) => entry?.name === input.targetApp)?.code ?? null
    )
  );

export const requireAndroidAppBuild = (input: AndroidRunInput) =>
  Effect.gen(function* appBuild() {
    const dump = yield* adb(input, [
      "shell",
      "dumpsys",
      "package",
      input.targetApp,
    ]);
    if (buildPattern.exec(dump)?.groups?.code !== input.environment.appBuild) {
      return yield* Effect.fail(platformRuntimeError("environment_changed"));
    }
  });

/** Read-only validation never changes permission choices during recovery. */
export const requireAndroidPermissionState = (
  input: AndroidRunInput,
  run: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>,
  code: "preparation_failed" | "environment_changed" = "environment_changed"
) =>
  Effect.gen(function* permissions() {
    const decisions = input.environment.permissions ?? [];
    if (decisions.length === 0) {
      return;
    }
    const dump = yield* run(["shell", "dumpsys", "package", input.targetApp]);
    const owner = dump
      .split(/(?=^\s*User \d+:)/mu)
      .find((section) => /^\s*User 0:/u.test(section));
    if (owner === undefined) {
      return yield* Effect.fail(platformRuntimeError(code));
    }
    for (const { permission, decision } of decisions) {
      const granted = new RegExp(
        `${permission.replaceAll(".", "\\.")}: granted=(true|false)`,
        "u"
      ).exec(owner)?.[1];
      if (granted !== (decision === "grant" ? "true" : "false")) {
        return yield* Effect.fail(platformRuntimeError(code));
      }
    }
  });

/** Read-only preflight never accepts current foreground state as freshness. */
export const preflightAndroidPreparation = (
  input: AndroidRunInput,
  phase?: "installed"
): Effect.Effect<void, PlatformRuntimeError> =>
  Effect.gen(function* preflight() {
    yield* requireAndroidDeviceIdentity(input.device, (args) =>
      adb(input, args)
    );
    const release = yield* adb(input, [
      "shell",
      "getprop",
      "ro.build.version.release",
    ]);
    if (release !== input.environment.androidVersion) {
      return yield* Effect.fail(platformRuntimeError("device_mismatch"));
    }
    if (input.appInstallation === undefined || phase === "installed") {
      yield* requireAndroidAppBuild(input);
      if (phase === "installed") {
        yield* requireAndroidPermissionState(input, (args) => adb(input, args));
      }
      return;
    }
    const installation = input.appInstallation;
    const bytes = yield* Effect.tryPromise({
      catch: () => platformRuntimeError("preparation_failed"),
      try: () => readFile(installation.apk),
    });
    if (
      createHash("sha256").update(bytes).digest("hex") !== installation.sha256
    ) {
      return yield* Effect.fail(platformRuntimeError("installation_denied"));
    }
    const metadata = yield* readLocalApkBadging(installation.apk).pipe(
      Effect.mapError(() => platformRuntimeError("preparation_failed"))
    );
    const identity = apkPattern.exec(metadata)?.groups;
    if (
      identity?.appId !== input.targetApp ||
      identity.build !== input.environment.appBuild
    ) {
      return yield* Effect.fail(platformRuntimeError("environment_changed"));
    }
  });

/** App-scoped preparation. Permission flags prevent a denied choice from prompting again. */
export const prepareAndroidAppData = (
  input: AndroidRunInput,
  run: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>
) =>
  Effect.gen(function* prepareApp() {
    yield* requireAndroidDeviceIdentity(input.device, run);
    const mutate = run;
    for (const { permission, decision } of input.environment.permissions ??
      []) {
      for (const args of [
        ["shell", "pm", decision, "--user", "0", input.targetApp, permission],
        [
          "shell",
          "pm",
          "set-permission-flags",
          "--user",
          "0",
          input.targetApp,
          permission,
          "user-set",
          "user-fixed",
        ],
      ]) {
        // pm prints nothing on success; an unknown command or permission prints a reason.
        if ((yield* mutate(args)) !== "") {
          return yield* Effect.fail(platformRuntimeError("preparation_failed"));
        }
      }
    }
    yield* requireAndroidPermissionState(input, run, "preparation_failed");
  });

/** Called only after all Run decisions, inside the selected-device lock. */
export const prepareAndroidStartingState = (
  request: AndroidRunInput,
  directory: string
) =>
  Effect.gen(function* prepare() {
    let input = request;
    if (request.appInstallation !== undefined) {
      const ownedApk = path.join(directory, "authorized-target.apk");
      yield* Effect.tryPromise({
        catch: () => platformRuntimeError("preparation_failed"),
        try: async () => {
          const bytes = await readFile(request.appInstallation?.apk ?? "");
          await writeFile(ownedApk, bytes, { mode: 0o600 });
        },
      });
      input = {
        ...request,
        appInstallation: { ...request.appInstallation, apk: ownedApk },
      };
    }
    yield* preflightAndroidPreparation(input);
    const mutate = (args: readonly string[]) => adb(input, args);
    if (input.appInstallation !== undefined) {
      yield* installAndroidApk(input, input.appInstallation.apk);
    }
    yield* requireAndroidAppBuild(input);
    yield* mutate([
      "shell",
      "am",
      "force-stop",
      "--user",
      "0",
      input.targetApp,
    ]);
    yield* prepareAndroidAppData(input, (args) => adb(input, args));
    const launched = yield* mutate([
      "shell",
      "am",
      "start",
      "--user",
      "0",
      "-W",
      "-n",
      `'${input.setup.activity}'`,
    ]);
    if (!/^Status: ok$/mu.test(launched) || /Error:/u.test(launched)) {
      return yield* Effect.fail(platformRuntimeError("preparation_failed"));
    }
  });
