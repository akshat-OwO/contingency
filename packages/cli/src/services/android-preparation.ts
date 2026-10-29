import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { requireAndroidDeviceIdentity } from "./android-device-identity.ts";
import type { AndroidRunInput } from "./android-run-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
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
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (sdk === undefined) {
      return yield* Effect.fail(platformRuntimeError("preparation_failed"));
    }
    const metadata = yield* command(path.join(sdk, "build-tools/36.0.0/aapt"), [
      "dump",
      "badging",
      installation.apk,
    ]);
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
      const result = yield* mutate([
        "install",
        "--user",
        "0",
        "-r",
        input.appInstallation.apk,
      ]);
      if (!/^Success$/mu.test(result) || /Failure/u.test(result)) {
        return yield* Effect.fail(platformRuntimeError("preparation_failed"));
      }
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
