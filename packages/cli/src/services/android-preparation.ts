import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import type { AndroidRunInput } from "./android-run-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const execute = promisify(execFile);
const buildPattern = /\bversionCode=(?<code>\d+)\b/u;
const apkPattern =
  /^package: name='(?<appId>[^']+)' versionCode='(?<build>\d+)'/mu;
const serialPattern = /^emulator-\d+$/u;

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

/** Read-only preflight never accepts current foreground state as freshness. */
export const preflightAndroidPreparation = (
  input: AndroidRunInput,
  phase?: "installed"
): Effect.Effect<void, PlatformRuntimeError> =>
  Effect.gen(function* preflight() {
    if (!serialPattern.test(input.device.serial)) {
      return yield* Effect.fail(
        platformRuntimeError("device_selection_required")
      );
    }
    const avd = yield* adb(input, ["emu", "avd", "name"]);
    const api = yield* adb(input, ["shell", "getprop", "ro.build.version.sdk"]);
    const fingerprint = yield* adb(input, [
      "shell",
      "getprop",
      "ro.build.fingerprint",
    ]);
    const release = yield* adb(input, [
      "shell",
      "getprop",
      "ro.build.version.release",
    ]);
    const emulator = yield* adb(input, ["shell", "getprop", "ro.kernel.qemu"]);
    if (
      avd.split(/\r?\n/u)[0] !== input.device.avd ||
      api !== "36" ||
      release !== input.environment.androidVersion ||
      fingerprint !== input.device.fingerprint ||
      emulator !== "1"
    ) {
      return yield* Effect.fail(platformRuntimeError("device_mismatch"));
    }
    if (input.appInstallation === undefined || phase === "installed") {
      yield* requireAndroidAppBuild(input);
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
    if (input.appInstallation !== undefined) {
      const result = yield* adb(input, [
        "install",
        "-r",
        input.appInstallation.apk,
      ]);
      if (!/^Success$/mu.test(result) || /Failure/u.test(result)) {
        return yield* Effect.fail(platformRuntimeError("preparation_failed"));
      }
    }
    yield* requireAndroidAppBuild(input);
    yield* adb(input, ["shell", "am", "force-stop", input.targetApp]);
    const launched = yield* adb(input, [
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `'${input.setup.activity}'`,
    ]);
    if (!/^Status: ok$/mu.test(launched) || /Error:/u.test(launched)) {
      return yield* Effect.fail(platformRuntimeError("preparation_failed"));
    }
  });
