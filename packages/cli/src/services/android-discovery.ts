import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  AndroidDiscoveredApp,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
  isAndroidSupportedApi,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";
import { yazl } from "playwright-core/lib/utilsBundle";

import { requireAndroidDeviceIdentity } from "./android-device-identity.ts";
import type { AndroidDeviceSelection } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";

export interface AndroidDiscoveryError {
  readonly code:
    | keyof typeof messages
    | "android_discovery_failed"
    | "android_app_metadata_unavailable";
  readonly message: string;
}
const messages = {
  android_api_unsupported:
    "This Android API level is outside the Support Matrix. Select a device running API 30 through 36; API levels below 30 are unsupported.",
  android_device_unauthorized:
    "Explicitly select and authorize the same connected Android device before listing apps.",
  physical_device_unsupported:
    "Physical Android devices are unsupported. Select an emulator.",
} as const;
const failure = (
  code:
    | keyof typeof messages
    | "android_discovery_failed" = "android_discovery_failed"
): AndroidDiscoveryError => ({
  code,
  message:
    code === "android_discovery_failed"
      ? "Android discovery failed. Check ADB connectivity and Android SDK build-tools."
      : messages[code],
});
const serialPattern = /^[A-Za-z0-9._:-]+$/u;
const componentPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\/[A-Za-z0-9_.$]+$/u;
const apkPathPattern = /^package:(?<apk>\/[A-Za-z0-9_./=+~@-]+\.apk)$/u;
const packagePattern =
  /^package: name='(?<package>[^']+)' versionCode='(?<versionCode>[^']+)' versionName='(?<versionName>[^']*)'/mu;
const labelPattern = /^application-label:'(?<label>.*)'$/mu;
const applicationLabelPattern = /^application: label='(?<label>.*)' icon='/mu;
const launcherLabelPattern =
  /^launchable-activity: name='(?<activity>[^']+)'\s+label='(?<label>.*)' icon='/gmu;
const appLabel = (metadata: string, packageName: string, component: string) => {
  const activity = component.slice(packageName.length + 1);
  const className = activity.startsWith(".")
    ? `${packageName}${activity}`
    : activity;
  const launcherLabel = [...metadata.matchAll(launcherLabelPattern)].find(
    (match) => match.groups?.activity === className
  )?.groups?.label;
  return (
    labelPattern.exec(metadata)?.groups?.label ||
    applicationLabelPattern.exec(metadata)?.groups?.label ||
    launcherLabel ||
    packageName
  );
};
const execute = promisify(execFile);
const host = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: () => failure(),
    try: async (signal) => {
      const { stdout } = await execute(file, args, {
        maxBuffer: 16 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      return stdout.trim();
    },
  });

/** Copies only to an owned host directory. Never installs or runs device code. */
const readApk = (serial: string, apk: string) =>
  Effect.scoped(
    Effect.gen(function* inspectApk() {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: () => failure(),
          try: () => mkdtemp(path.join(tmpdir(), "contingency-discovery-")),
        }),
        (owned) =>
          Effect.promise(() => rm(owned, { force: true, recursive: true }))
      );
      const sdk =
        process.env.ANDROID_HOME ??
        process.env.ANDROID_SDK_ROOT ??
        path.join(homedir(), "Library/Android/sdk");
      const tools = path.join(sdk, "build-tools");
      const versions = yield* Effect.tryPromise({
        catch: () => failure(),
        try: () => readdir(tools),
      });
      const [version] = versions
        .filter((entry) => /^\d+\.\d+\.\d+$/u.test(entry))
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (version === undefined) {
        return yield* Effect.fail(failure());
      }
      const local = path.join(directory, "base.apk");
      // Only the manifest and resource table are needed for labels and versions.
      // Stream them out without extracting anything onto the device.
      yield* Effect.tryPromise({
        catch: () => failure(),
        try: async (signal) => {
          const extract = async (entry: string) => {
            const { stdout } = await execute(
              "adb",
              ["-s", serial, "exec-out", "unzip", "-p", apk, entry],
              {
                encoding: "buffer",
                maxBuffer: 128 * 1024 * 1024,
                signal,
                timeout: 30_000,
              }
            );
            return stdout;
          };
          const entries = await Promise.allSettled(
            ["AndroidManifest.xml", "resources.arsc"].map(async (name) => ({
              buffer: await extract(name),
              name,
            }))
          );
          for (const entry of entries) {
            if (entry.status === "rejected") {
              throw entry.reason;
            }
          }
          const archive = new yazl.ZipFile();
          for (const entry of entries) {
            if (entry.status === "fulfilled" && entry.value.buffer.length > 0) {
              archive.addBuffer(entry.value.buffer, entry.value.name);
            }
          }
          archive.end();
          await pipeline(
            archive.outputStream,
            createWriteStream(local, { mode: 0o600 }),
            { signal }
          );
        },
      });
      return yield* host(path.join(tools, version, "aapt2"), [
        "dump",
        "badging",
        local,
      ]);
    })
  );

/** The only device commands here are reads, always bound to the explicit serial. */
const discoveryHost = {
  adb: (args: readonly string[]) => host("adb", args),
  avds: () => {
    const sdk =
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      path.join(homedir(), "Library/Android/sdk");
    return host(path.join(sdk, "emulator", "emulator"), ["-list-avds"]);
  },
  readApk,
};
const appendStoppedAvds = (
  devices: AndroidDiscoveredDevice[],
  inventory: string
) => {
  const running = new Set(devices.map((device) => device.avd));
  for (const avd of new Set(
    inventory
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean)
  )) {
    if (!running.has(avd)) {
      devices.push({
        api: null,
        avd,
        fingerprint: null,
        kind: "emulator",
        model: null,
        release: null,
        serial: `avd:${avd}`,
        state: "stopped",
      });
    }
  }
};
export const makeAndroidDiscovery = (
  io: {
    readonly adb: typeof discoveryHost.adb;
    readonly readApk: typeof readApk;
    readonly avds?: typeof discoveryHost.avds;
  } = discoveryHost
) => ({
  apps: (selection: AndroidDeviceSelection) =>
    Effect.gen(function* discoverApps() {
      // RPC selection authorizes hardware, never an implicit first/only device.
      const device = yield* Schema.decodeUnknownEffect(
        AndroidWorkspaceSelection.fields.device
      )(selection).pipe(
        Effect.mapError(() => failure("android_device_unauthorized"))
      );
      if (device.kind === "physical") {
        return yield* Effect.fail(failure("physical_device_unsupported"));
      }
      if (!serialPattern.test(device.serial)) {
        return yield* Effect.fail(failure("android_device_unauthorized"));
      }
      if (!isAndroidSupportedApi(device.api)) {
        return yield* Effect.fail(failure("android_api_unsupported"));
      }
      const adb = (args: readonly string[]) =>
        io.adb(["-s", device.serial, ...args]);
      yield* requireAndroidDeviceIdentity(device, (args) =>
        adb(args).pipe(
          Effect.mapError(() => platformRuntimeError("device_disconnected"))
        )
      ).pipe(Effect.mapError(() => failure("android_device_unauthorized")));
      const output = yield* adb([
        "shell",
        "cmd",
        "package",
        "query-activities",
        "--brief",
        "--components",
        "--user",
        "0",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
      ]);
      const components = [
        ...new Set(
          output
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => componentPattern.test(line))
        ),
      ];
      if (!components.length && output !== "No activities found") {
        return yield* Effect.fail(failure());
      }
      const apps: AndroidDiscoveredApp[] = [];
      const seen = new Set<string>();
      for (const component of components) {
        const [packageName] = component.split("/");
        if (!packageName || seen.has(packageName)) {
          continue;
        }
        seen.add(packageName);
        const paths = yield* adb([
          "shell",
          "pm",
          "path",
          "--user",
          "0",
          packageName,
        ]);
        const pathsList = paths
          .split(/\r?\n/u)
          .map((line) => apkPathPattern.exec(line)?.groups?.apk);
        const apk =
          pathsList.find((entry) => entry?.endsWith("/base.apk")) ??
          pathsList[0];
        if (!apk) {
          return yield* Effect.fail(failure());
        }
        const metadata = yield* io.readApk(device.serial, apk).pipe(
          Effect.mapError(() => ({
            code: "android_app_metadata_unavailable",
            message: `Could not read APK metadata for ${packageName}. Check ADB connectivity and SDK build-tools.`,
          }))
        );
        const match = packagePattern.exec(metadata)?.groups;
        const label = appLabel(metadata, packageName, component);
        if (match?.package !== packageName) {
          return yield* Effect.fail({
            code: "android_discovery_failed",
            message: `APK metadata for ${packageName} is missing its package or version.`,
          });
        }
        apps.push(
          yield* Schema.decodeUnknownEffect(AndroidDiscoveredApp)({
            label,
            launchActivity: component,
            package: packageName,
            versionCode: match.versionCode,
            versionName: match.versionName,
          }).pipe(Effect.mapError(() => failure()))
        );
      }
      // Refuse results if identity changed during the inventory.
      yield* requireAndroidDeviceIdentity(device, (args) =>
        adb(args).pipe(
          Effect.mapError(() => platformRuntimeError("device_disconnected"))
        )
      ).pipe(Effect.mapError(() => failure("android_device_unauthorized")));
      return apps;
    }),
  devices: () =>
    Effect.gen(function* discoverDevices() {
      const output = yield* io.adb(["devices", "-l"]);
      const devices: AndroidDiscoveredDevice[] = [];
      for (const line of output.split(/\r?\n/u).slice(1)) {
        if (!line.trim()) {
          continue;
        }
        const [serial, rawState] = line.trim().split(/\s+/u);
        if (!serial || !serialPattern.test(serial)) {
          return yield* Effect.fail(failure());
        }
        const state =
          rawState === "device" ||
          rawState === "offline" ||
          rawState === "unauthorized"
            ? rawState
            : "unavailable";
        if (!serial.startsWith("emulator-")) {
          devices.push({
            api: null,
            avd: null,
            fingerprint: null,
            kind: "physical",
            model: null,
            release: null,
            serial,
            state,
          });
          continue;
        }
        const read = (property: string) =>
          io.adb(["-s", serial, "shell", "getprop", property]);
        const model =
          state === "device" ? yield* read("ro.product.model") : null;
        const api =
          state === "device"
            ? Number(yield* read("ro.build.version.sdk"))
            : null;
        const emulator =
          state === "device"
            ? (yield* read("ro.kernel.qemu")) === "1"
            : serial.startsWith("emulator-");
        const fingerprint =
          state === "device" ? yield* read("ro.build.fingerprint") : null;
        const release =
          state === "device" ? yield* read("ro.build.version.release") : null;
        const avd =
          state === "device" && emulator
            ? ((yield* io.adb(["-s", serial, "emu", "avd", "name"])).split(
                /\r?\n/u
              )[0] ?? null)
            : null;
        devices.push(
          yield* Schema.decodeUnknownEffect(AndroidDiscoveredDevice)({
            api,
            avd,
            fingerprint,
            kind: emulator ? "emulator" : "physical",
            model,
            release: release || null,
            serial,
            state,
          }).pipe(Effect.mapError(() => failure()))
        );
      }
      // A missing emulator binary must not hide connected phones.
      const inventory =
        io.avds === undefined
          ? ""
          : yield* io.avds().pipe(Effect.catch(() => Effect.succeed("")));
      appendStoppedAvds(devices, inventory);
      return devices;
    }),
});

export const androidDiscovery = makeAndroidDiscovery();
