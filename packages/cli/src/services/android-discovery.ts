import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  AndroidDiscoveredApp,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
  foldAndroidDiscoveredAppsEvents,
  isAndroidSupportedApi,
} from "@contingency/protocol";
import type { AndroidDiscoveredAppsEvent } from "@contingency/protocol";
import { Cause, Effect, Option, Schema, Stream } from "effect";
import { yazl } from "playwright-core/lib/utilsBundle";

import {
  isPhysicalAndroidSelection,
  requireAndroidDeviceIdentity,
} from "./android-device-identity.ts";
import type { AndroidDeviceSelection } from "./android-runtime-contract.ts";
import { runChild, runChildText } from "./child-process.ts";
import type {
  ChildOutput,
  ChildProcessFailure,
  Recognized,
} from "./child-process.ts";
import { recordFailure } from "./failure-reference.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";

export interface AndroidDiscoveryError {
  readonly code:
    | keyof typeof messages
    | "android_discovery_failed"
    | "android_app_metadata_unavailable"
    | "android_build_tools_missing";
  readonly message: string;
  /** Names the recorded cause of a host command that failed unexplained. */
  readonly failureReference?: string;
}

export interface CachedAppMetadata {
  readonly label: string;
  readonly updatedAt: number;
  readonly versionCode: string;
  readonly versionName: string;
}

export interface AndroidAppMetadataCache {
  readonly load: () => Effect.Effect<ReadonlyMap<string, CachedAppMetadata>>;
  /** Merges newly verified entries into the persisted cache. */
  readonly save: (
    updates: ReadonlyMap<string, CachedAppMetadata>
  ) => Effect.Effect<void>;
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
    | "android_discovery_failed" = "android_discovery_failed",
  detail?: string
): AndroidDiscoveryError => {
  if (code !== "android_discovery_failed") {
    return { code, message: messages[code] };
  }
  const message = detail
    ? `Android discovery failed: ${detail}`
    : "Android discovery failed. Check ADB connectivity and Android SDK build-tools.";
  return { code, message };
};

const MAX_DETAIL_CHARS = 200;
const HOST_TIMEOUT_MS = 30_000;
const ENRICHMENT_CONCURRENCY = 1;
const MAX_CACHE_ENTRIES = 500;

const trimDetail = (text: string): string => {
  const singleLine = text.trim().replaceAll(/\s+/gu, " ");
  if (singleLine.length <= MAX_DETAIL_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_DETAIL_CHARS - 1)}…`;
};

const formatCommand = (file: string, args: readonly string[]): string =>
  `${path.basename(file)} ${args.slice(0, 6).join(" ")}`.trim();

const formatExitText = (code: number | null, signal: string | null): string => {
  if (code !== null) {
    return ` (exit ${String(code)})`;
  }
  if (signal !== null) {
    return ` (signal ${signal})`;
  }
  return "";
};

const DISCONNECTED =
  /device offline|device '[^']+' not found|no devices\/emulators found|protocol fault|closed/iu;

/** adb's disconnect, recognized in its stderr; the stderr itself stays local. */
const recognizeAdb = ({ stderr }: ChildOutput): Recognized =>
  DISCONNECTED.test(stderr) ? { code: "device_disconnected" } : {};

/**
 * An actionable host-command failure by its shape: what ran and how it
 * ended. What the command printed stays behind the Failure Reference.
 */
export const describeHostFailure = (
  file: string,
  args: readonly string[],
  cause: ChildProcessFailure,
  timeoutMs = HOST_TIMEOUT_MS
): string => {
  const command = formatCommand(file, args);
  if (cause.errno === "ENOENT") {
    return `Could not run ${path.basename(file)}: command not found.`;
  }
  if (cause.code === "timed_out") {
    return `${command} timed out after ${Math.round(timeoutMs / 1000)}s.`;
  }
  if (cause.recognized.code === "device_disconnected") {
    return `ADB device disconnected during ${command}.`;
  }
  return `${command} failed${formatExitText(cause.exitCode, cause.signal)}.`;
};

/**
 * A failed host command as a discovery failure. One that does not explain
 * itself names a Failure Reference, which keeps the command's output.
 */
const hostFailure = (
  code: "android_discovery_failed" | "android_app_metadata_unavailable",
  message: string,
  cause: ChildProcessFailure
): Effect.Effect<never, AndroidDiscoveryError> =>
  cause.errno === "ENOENT" || cause.recognized.code === "device_disconnected"
    ? Effect.fail({ code, message })
    : recordFailure(Cause.fail(cause), code).pipe(
        Effect.flatMap((failureReference) =>
          Effect.fail({ code, failureReference, message })
        )
      );

const serialPattern = /^[A-Za-z0-9._:-]+$/u;
const componentPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\/[A-Za-z0-9_.$]+$/u;
const apkPathPattern = /^package:(?<apk>\/[A-Za-z0-9_./=+~@-]+\.apk)$/u;
const packageListWithPathPattern =
  /^package:(?<apk>\/.+?\.apk)=(?<package>\S+)\s+versionCode:(?<versionCode>\d+)\s*$/u;
const packageListVersionOnlyPattern =
  /^package:(?<package>\S+)\s+versionCode:(?<versionCode>\d+)\s*$/u;
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

const host = (file: string, args: readonly string[]) =>
  runChildText({
    args,
    child: path.basename(file),
    command: file,
    recognize: recognizeAdb,
    timeoutMs: HOST_TIMEOUT_MS,
  }).pipe(
    Effect.catchTag("ChildProcessFailure", (cause) =>
      hostFailure(
        "android_discovery_failed",
        failure(
          "android_discovery_failed",
          describeHostFailure(file, args, cause)
        ).message,
        cause
      )
    )
  );

const AndroidAppMetadataCacheEntrySchema = Schema.Struct({
  label: Schema.String,
  updatedAt: Schema.Finite,
  versionCode: Schema.String,
  versionName: Schema.String,
});

const AndroidAppMetadataCacheFileSchema = Schema.Struct({
  entries: Schema.Record(Schema.String, AndroidAppMetadataCacheEntrySchema),
  version: Schema.Literal(1),
});

export const defaultAndroidAppMetadataCachePath = () =>
  path.join(homedir(), ".contingency", "cache", "android-app-metadata.json");

export const noopAndroidAppMetadataCache: AndroidAppMetadataCache = {
  load: () => Effect.succeed(new Map<string, CachedAppMetadata>()),
  save: () => Effect.void,
};

/**
 * Bounded, best-effort on-disk cache for resolved Android APK labels and
 * versions. Corruption or I/O errors never break discovery.
 */
export const makeFileAndroidAppMetadataCache = (
  filePath: string = defaultAndroidAppMetadataCachePath(),
  maxEntries: number = MAX_CACHE_ENTRIES
): AndroidAppMetadataCache => {
  const readDiskEntries = async (): Promise<Map<string, CachedAppMetadata>> => {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const decoded = Schema.decodeUnknownOption(
        AndroidAppMetadataCacheFileSchema
      )(parsed);
      if (Option.isNone(decoded)) {
        return new Map<string, CachedAppMetadata>();
      }
      return new Map<string, CachedAppMetadata>(
        Object.entries(decoded.value.entries)
      );
    } catch {
      return new Map<string, CachedAppMetadata>();
    }
  };

  let writeSequence = 0;
  let pendingWrite: Promise<void> = Promise.resolve();
  const serializeWrite = (task: () => Promise<void>) => {
    const previous = pendingWrite;
    const run = async () => {
      await previous;
      await task();
    };
    const next = run();
    pendingWrite = next;
    return next;
  };

  return {
    load: () => Effect.promise(readDiskEntries),
    save: (updates) =>
      Effect.promise(async () => {
        if (updates.size === 0) {
          return;
        }
        await serializeWrite(async () => {
          try {
            const merged = await readDiskEntries();
            for (const [key, entry] of updates) {
              const existing = merged.get(key);
              if (
                existing === undefined ||
                entry.updatedAt >= existing.updatedAt
              ) {
                merged.set(key, entry);
              }
            }
            const bounded = [...merged.entries()]
              .toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)
              .slice(0, maxEntries);
            const payload = {
              entries: Object.fromEntries(bounded),
              version: 1 as const,
            };
            const dir = path.dirname(filePath);
            await mkdir(dir, { recursive: true });
            writeSequence += 1;
            const temporary = path.join(
              dir,
              `.android-app-metadata.${process.pid}.${Date.now()}.${writeSequence}.tmp`
            );
            try {
              await writeFile(temporary, JSON.stringify(payload), {
                encoding: "utf-8",
                mode: 0o600,
              });
              await rename(temporary, filePath);
            } catch (error) {
              try {
                await rm(temporary, { force: true });
              } catch {
                // Best-effort temp cleanup.
              }
              throw error;
            }
          } catch {
            // Best-effort cache write; never fail discovery.
          }
        });
      }),
  };
};

const metadataCacheKey = (
  fingerprint: string,
  packageName: string,
  apkPath: string,
  versionCode: string
) => `${fingerprint}\0${packageName}\0${apkPath}\0${versionCode}`;

/** The newest installed Android SDK build-tools directory. */
export const androidBuildTools = Effect.gen(function* buildTools() {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(homedir(), "Library/Android/sdk");
  const tools = path.join(sdk, "build-tools");
  const missing = {
    code: "android_build_tools_missing" as const,
    message: "Install Android SDK build-tools in Android Studio.",
  };
  const versions = yield* Effect.tryPromise({
    catch: () => missing,
    try: () => readdir(tools),
  });
  const [version] = versions
    .filter((entry) => /^\d+\.\d+\.\d+$/u.test(entry))
    .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (version === undefined) {
    return yield* Effect.fail(missing);
  }
  return path.join(tools, version);
});

/** `aapt2 dump badging` of an APK already on this host. Reads only. */
export const readLocalApkBadging = (apk: string) =>
  androidBuildTools.pipe(
    Effect.flatMap((tools) =>
      host(path.join(tools, "aapt2"), ["dump", "badging", apk])
    )
  );

const launchablePattern = /^launchable-activity: name='(?<activity>[^']+)'/mu;

/**
 * The installed-app shape of an APK's badging, validated as discovery
 * validates an installed app. Undefined when a required field is missing.
 */
export const parseApkBadging = (
  metadata: string
): AndroidDiscoveredApp | undefined => {
  const match = packagePattern.exec(metadata)?.groups;
  const activity = launchablePattern.exec(metadata)?.groups?.activity;
  if (match?.package === undefined || activity === undefined) {
    return undefined;
  }
  const relative = activity.startsWith(`${match.package}.`)
    ? activity.slice(match.package.length)
    : activity;
  const component = `${match.package}/${relative}`;
  if (!componentPattern.test(component)) {
    return undefined;
  }
  return Schema.decodeUnknownOption(AndroidDiscoveredApp)({
    label: appLabel(metadata, match.package, component),
    launchActivity: component,
    package: match.package,
    versionCode: match.versionCode,
    versionName: match.versionName ?? "",
  }).pipe(Option.getOrUndefined);
};

/** Copies only to an owned host directory. Never installs or runs device code. */
const readApk = (serial: string, apk: string) =>
  Effect.scoped(
    Effect.gen(function* inspectApk() {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: (cause) =>
            failure(
              "android_discovery_failed",
              `Could not create temporary discovery directory: ${trimDetail(String(cause))}`
            ),
          try: () => mkdtemp(path.join(tmpdir(), "contingency-discovery-")),
        }),
        (owned) =>
          Effect.promise(() => rm(owned, { force: true, recursive: true }))
      );
      const tools = yield* androidBuildTools;
      const local = path.join(directory, "base.apk");
      // Only the manifest and resource table are needed for labels and versions.
      // Stream them out without extracting anything onto the device.
      const extract = (entry: string) =>
        runChild({
          args: ["-s", serial, "exec-out", "unzip", "-p", apk, entry],
          child: "adb",
          command: "adb",
          maxOutputBytes: 128 * 1024 * 1024,
          recognize: recognizeAdb,
          timeoutMs: HOST_TIMEOUT_MS,
        }).pipe(
          Effect.catchTag("ChildProcessFailure", (cause) =>
            hostFailure(
              "android_app_metadata_unavailable",
              describeHostFailure(
                "adb",
                ["-s", serial, "exec-out", "unzip", "-p", apk],
                cause
              ),
              cause
            )
          )
        );
      const manifestBuffer = yield* extract("AndroidManifest.xml");
      if (manifestBuffer.length === 0) {
        return yield* Effect.fail({
          code: "android_app_metadata_unavailable" as const,
          message: `adb exec-out returned empty AndroidManifest.xml for ${apk} (possible ADB transport drop).`,
        });
      }
      const resourcesBuffer = yield* extract("resources.arsc");
      yield* Effect.tryPromise({
        catch: () => ({
          code: "android_app_metadata_unavailable" as const,
          message: "Could not write the APK metadata for reading.",
        }),
        try: async (signal) => {
          const archive = new yazl.ZipFile();
          archive.addBuffer(manifestBuffer, "AndroidManifest.xml");
          if (resourcesBuffer.length > 0) {
            archive.addBuffer(resourcesBuffer, "resources.arsc");
          }
          archive.end();
          await pipeline(
            archive.outputStream,
            createWriteStream(local, { mode: 0o600 }),
            { signal }
          );
        },
      });
      return yield* host(path.join(tools, "aapt2"), ["dump", "badging", local]);
    })
  );

/** The only device commands here are reads, always bound to the explicit serial. */
export const androidDiscoveryHost = {
  adb: (args: readonly string[]) => host("adb", args),
  avds: () => {
    const sdk =
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      path.join(homedir(), "Library/Android/sdk");
    return host(path.join(sdk, "emulator", "emulator"), ["-list-avds"]);
  },
  cache: makeFileAndroidAppMetadataCache(),
  readApk,
};

interface InstalledPackageInfo {
  readonly apk: string | undefined;
  readonly versionCode: string;
}

interface PendingEnrichment {
  readonly apk: string | undefined;
  readonly component: string;
  readonly packageName: string;
  readonly versionCode: string;
}

const parseInstalledPackages = (output: string) => {
  const packages = new Map<string, InstalledPackageInfo>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const withPath = packageListWithPathPattern.exec(line)?.groups;
    if (withPath?.package !== undefined && withPath.versionCode !== undefined) {
      packages.set(withPath.package, {
        apk: withPath.apk,
        versionCode: withPath.versionCode,
      });
      continue;
    }
    const versionOnly = packageListVersionOnlyPattern.exec(line)?.groups;
    if (
      versionOnly?.package !== undefined &&
      versionOnly.versionCode !== undefined
    ) {
      packages.set(versionOnly.package, {
        apk: undefined,
        versionCode: versionOnly.versionCode,
      });
    }
  }
  return packages;
};

const validateDeviceSelection = (selection: AndroidDeviceSelection) =>
  Effect.gen(function* validateSelection() {
    // RPC selection authorizes hardware, never an implicit first/only device.
    const device = yield* Schema.decodeUnknownEffect(
      AndroidWorkspaceSelection.fields.device
    )(selection).pipe(
      Effect.mapError(() => failure("android_device_unauthorized"))
    );
    if (isPhysicalAndroidSelection(device)) {
      return yield* Effect.fail(failure("physical_device_unsupported"));
    }
    if (!serialPattern.test(device.serial)) {
      return yield* Effect.fail(failure("android_device_unauthorized"));
    }
    if (!isAndroidSupportedApi(device.api)) {
      return yield* Effect.fail(failure("android_api_unsupported"));
    }
    return device;
  });

const buildInitialInventory = (
  fingerprint: string,
  components: readonly string[],
  installed: ReadonlyMap<string, InstalledPackageInfo>,
  cacheEntries: ReadonlyMap<string, CachedAppMetadata>
) =>
  Effect.gen(function* buildSnapshot() {
    const initialApps: AndroidDiscoveredApp[] = [];
    const pending: PendingEnrichment[] = [];
    const seen = new Set<string>();
    for (const component of components) {
      const [packageName] = component.split("/");
      if (!packageName || seen.has(packageName)) {
        continue;
      }
      seen.add(packageName);
      const pkgInfo = installed.get(packageName);
      const versionCode = pkgInfo?.versionCode ?? "0";
      const apk = pkgInfo?.apk;
      const cached =
        apk === undefined
          ? undefined
          : cacheEntries.get(
              metadataCacheKey(fingerprint, packageName, apk, versionCode)
            );
      initialApps.push(
        yield* Schema.decodeUnknownEffect(AndroidDiscoveredApp)({
          label: cached?.label ?? packageName,
          launchActivity: component,
          package: packageName,
          versionCode: cached?.versionCode ?? versionCode,
          versionName: cached?.versionName ?? "",
        }).pipe(Effect.mapError(() => failure()))
      );
      if (cached === undefined) {
        pending.push({ apk, component, packageName, versionCode });
      }
    }
    return { initialApps, pending };
  });

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
    readonly adb: typeof androidDiscoveryHost.adb;
    readonly readApk: typeof readApk;
    readonly avds?: typeof androidDiscoveryHost.avds;
    readonly cache?: AndroidAppMetadataCache;
  } = androidDiscoveryHost
) => {
  const cache = io.cache ?? noopAndroidAppMetadataCache;

  const appsStream = (
    selection: AndroidDeviceSelection
  ): Stream.Stream<AndroidDiscoveredAppsEvent, AndroidDiscoveryError> =>
    Stream.unwrap(
      Effect.gen(function* prepareInventory() {
        const device = yield* validateDeviceSelection(selection);
        const adb = (args: readonly string[]) =>
          io.adb(["-s", device.serial, ...args]);
        const verifyIdentity = () =>
          requireAndroidDeviceIdentity(device, (args) =>
            adb(args).pipe(
              Effect.mapError(() => platformRuntimeError("device_disconnected"))
            )
          ).pipe(Effect.mapError(() => failure("android_device_unauthorized")));

        yield* verifyIdentity();

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
          return yield* Effect.fail(
            failure(
              "android_discovery_failed",
              `Unexpected launcher activity query output: ${trimDetail(output || "(empty)")}`
            )
          );
        }

        const installedOutput = yield* adb([
          "shell",
          "pm",
          "list",
          "packages",
          "--user",
          "0",
          "-f",
          "--show-versioncode",
        ]);
        const installed = parseInstalledPackages(installedOutput);
        // Re-verify device identity before publishing the fast snapshot.
        yield* verifyIdentity();

        const cacheEntries = new Map(yield* cache.load());
        const { initialApps, pending } = yield* buildInitialInventory(
          device.fingerprint,
          components,
          installed,
          cacheEntries
        );

        const verifiedUpdates = new Map<string, CachedAppMetadata>();
        let enrichmentStopped = false;

        const resolveApkPath = (item: PendingEnrichment) =>
          Effect.gen(function* findApk() {
            if (item.apk !== undefined) {
              return item.apk;
            }
            const paths = yield* adb([
              "shell",
              "pm",
              "path",
              "--user",
              "0",
              item.packageName,
            ]);
            const pathsList = paths
              .split(/\r?\n/u)
              .map((line) => apkPathPattern.exec(line)?.groups?.apk);
            return (
              pathsList.find((entry) => entry?.endsWith("/base.apk")) ??
              pathsList[0]
            );
          }).pipe(Effect.orElseSucceed(() => ""));

        const readApkOnceWithRetry = (apk: string) =>
          io.readApk(device.serial, apk).pipe(
            Effect.matchEffect({
              onFailure: (firstError) => {
                if (firstError.code === "android_build_tools_missing") {
                  enrichmentStopped = true;
                  return Effect.fail(firstError);
                }
                return io.readApk(device.serial, apk);
              },
              onSuccess: Effect.succeed,
            })
          );

        const verifyIdentityBeforePublish = () =>
          requireAndroidDeviceIdentity(device, (args) =>
            adb(args).pipe(
              Effect.mapError(() => platformRuntimeError("device_disconnected"))
            )
          ).pipe(
            Effect.matchEffect({
              onFailure: (cause) => {
                if (cause.code === "device_disconnected") {
                  enrichmentStopped = true;
                  return Effect.succeed(false);
                }
                return Effect.fail(failure("android_device_unauthorized"));
              },
              onSuccess: () => Effect.succeed(true),
            })
          );

        const enrichOne = (
          item: PendingEnrichment
        ): Effect.Effect<
          AndroidDiscoveredAppsEvent | null,
          AndroidDiscoveryError
        > =>
          Effect.gen(function* enrichPackage() {
            if (enrichmentStopped) {
              return null;
            }
            const apk = yield* resolveApkPath(item);
            if (!apk) {
              return null;
            }
            const cachedByResolvedApk = cacheEntries.get(
              metadataCacheKey(
                device.fingerprint,
                item.packageName,
                apk,
                item.versionCode
              )
            );
            if (cachedByResolvedApk !== undefined) {
              const verified = yield* verifyIdentityBeforePublish();
              if (!verified) {
                return null;
              }
              return {
                _tag: "metadata" as const,
                label: cachedByResolvedApk.label,
                package: item.packageName,
                versionCode: cachedByResolvedApk.versionCode,
                versionName: cachedByResolvedApk.versionName,
              };
            }
            const metadataResult = yield* readApkOnceWithRetry(apk).pipe(
              Effect.option
            );
            if (Option.isNone(metadataResult)) {
              return null;
            }
            const metadata = metadataResult.value;
            const match = packagePattern.exec(metadata)?.groups;
            if (match?.package !== item.packageName) {
              return null;
            }
            const label = appLabel(metadata, item.packageName, item.component);
            const resolvedVersionCode = match.versionCode || item.versionCode;
            const resolvedVersionName = match.versionName ?? "";
            const decoded = Schema.decodeUnknownOption(AndroidDiscoveredApp)({
              label,
              launchActivity: item.component,
              package: item.packageName,
              versionCode: resolvedVersionCode,
              versionName: resolvedVersionName,
            });
            if (Option.isNone(decoded)) {
              return null;
            }
            // Re-verify device identity before caching or publishing this entry.
            const verified = yield* verifyIdentityBeforePublish();
            if (!verified) {
              return null;
            }
            const key = metadataCacheKey(
              device.fingerprint,
              item.packageName,
              apk,
              resolvedVersionCode
            );
            const entry: CachedAppMetadata = {
              label: decoded.value.label,
              updatedAt: Date.now(),
              versionCode: decoded.value.versionCode,
              versionName: decoded.value.versionName,
            };
            cacheEntries.set(key, entry);
            verifiedUpdates.set(key, entry);
            return {
              _tag: "metadata" as const,
              label: decoded.value.label,
              package: decoded.value.package,
              versionCode: decoded.value.versionCode,
              versionName: decoded.value.versionName,
            };
          });

        const snapshotStream: Stream.Stream<
          AndroidDiscoveredAppsEvent,
          AndroidDiscoveryError
        > = Stream.make({
          _tag: "snapshot" as const,
          apps: initialApps,
        });

        const enrichmentStream: Stream.Stream<
          AndroidDiscoveredAppsEvent,
          AndroidDiscoveryError
        > = Stream.fromIterable(pending).pipe(
          Stream.mapEffect(enrichOne, { concurrency: ENRICHMENT_CONCURRENCY }),
          Stream.filter(
            (event): event is AndroidDiscoveredAppsEvent => event !== null
          ),
          // Persist only this stream's newly verified entries, merged with any
          // concurrent stream's writes, even when the subscriber cancels early.
          Stream.ensuring(
            Effect.suspend(() =>
              verifiedUpdates.size > 0
                ? cache.save(verifiedUpdates)
                : Effect.void
            )
          )
        );

        return snapshotStream.pipe(Stream.concat(enrichmentStream));
      })
    );

  const apps = (selection: AndroidDeviceSelection) =>
    Stream.runCollect(appsStream(selection)).pipe(
      Effect.map(foldAndroidDiscoveredAppsEvents)
    );

  return {
    apps,
    appsStream,
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
            return yield* Effect.fail(
              failure(
                "android_discovery_failed",
                `Unexpected adb devices line: ${trimDetail(line)}`
              )
            );
          }
          const state =
            rawState === "device" ||
            rawState === "offline" ||
            rawState === "unauthorized"
              ? rawState
              : "unavailable";
          if (isPhysicalAndroidSelection({ serial })) {
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
            : yield* io.avds().pipe(Effect.orElseSucceed(() => ""));
        appendStoppedAvds(devices, inventory);
        return devices;
      }),
  };
};

export const androidDiscovery = makeAndroidDiscovery();
