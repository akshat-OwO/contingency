import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AndroidElementBounds } from "@contingency/protocol";
import { createAgentDeviceClient, isAgentDeviceError } from "agent-device";
import type {
  AgentDeviceIdentifiers,
  CaptureSnapshotResult,
  SnapshotNode,
} from "agent-device";
import { Effect, Exit, Schema, Scope } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { requireAndroidDeviceIdentity } from "./android-device-identity.ts";
import {
  acquireAndroidDeviceLock,
  androidDeviceLockPath,
} from "./android-device-lock.ts";
import {
  androidNodeInteraction,
  androidNodeName,
} from "./android-observation.ts";
import {
  prepareAndroidStartingState,
  requireAndroidAppBuild,
  requireAndroidPermissionState,
} from "./android-preparation.ts";
import type { AndroidRunInput } from "./android-run-contract.ts";
import { androidHelperRelease } from "./android-runtime-contract.ts";
import type {
  AndroidObservation,
  AndroidRuntimeBackend,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import {
  ANDROID_RUNTIME_PREFIX,
  defaultAgentDeviceClaimsDirectory,
  reclaimOrphanedAndroidRuntimes,
  writeAndroidRuntimeOwner,
} from "./android-runtime-reclaim.ts";
import { makeAndroidSessionLifecycle } from "./android-session-lifecycle.ts";
import { androidWindowVisibility } from "./android-stream-contract.ts";
import { performNativeAppFill } from "./native-app-fill.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const execute = promisify(execFile);
const serialPattern = /^[A-Za-z0-9._:-]+$/u;
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const focusPattern =
  /mCurrentFocus=(?<window>Window\{[^\n]*?\su(?<userId>\d+)\s(?<packageName>[A-Za-z][A-Za-z0-9_.]+)\/[^\n}]*\})/u;
const packagePathPattern =
  /^package:(?<apk>\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk)$/mu;
const DaemonInfo = Schema.Struct({
  httpPort: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: 65_535, minimum: 1 })
  ),
  stateDir: Schema.String,
  token: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.String,
});
const ReleaseManifest = Schema.Struct({
  packageName: Schema.Literal(androidHelperRelease.packageName),
  sha256: Schema.Literal(androidHelperRelease.sha256),
  statusProtocol: Schema.Literal("android-snapshot-helper-v1"),
  version: Schema.Literal(androidHelperRelease.version),
  versionCode: Schema.Literal(androidHelperRelease.versionCode),
});

/**
 * Snapshot helper failures agent-device reports while the app window is
 * briefly empty or covered, as during a screen transition. They are the same
 * incomplete capture `requireCapture` refuses, raised instead of returned, so
 * they settle and repair the same way (#720).
 */
const isTransientSnapshotFailure = Schema.is(
  Schema.Struct({
    androidSnapshotHelperFailureReason: Schema.Literals([
      "content-poor-app-window",
      "empty-helper-output",
      "system-window-only",
    ]),
  })
);

/** Never export child output or SDK errors, which may contain user data. */
export const androidBackendError = (
  cause: unknown,
  code: Parameters<typeof platformRuntimeError>[0],
  step: NonNullable<PlatformRuntimeError["operation"]>
): PlatformRuntimeError => {
  const error = { ...platformRuntimeError(code), operation: step };
  if (!isAgentDeviceError(cause)) {
    return error;
  }
  // agent-device reports a device another session holds by code, not reason.
  if (cause.code === "DEVICE_IN_USE") {
    return { ...platformRuntimeError("device_in_use"), operation: step };
  }
  if (step === "capture" && isTransientSnapshotFailure(cause.details)) {
    return { ...platformRuntimeError("capture_incomplete"), operation: step };
  }
  const reason = cause.details?.reason;
  if (
    reason === "ref_generation_mismatch" ||
    reason === "stale_ref" ||
    reason === "device_not_found" ||
    reason === "request_canceled" ||
    reason === "android_text_input_unverified" ||
    reason === "input_unverified"
  ) {
    return { ...error, backendReason: reason };
  }
  return error;
};

const io = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  code: Parameters<typeof platformRuntimeError>[0] = "runtime_failed",
  step: NonNullable<PlatformRuntimeError["operation"]> = "host-io"
) =>
  Effect.tryPromise({
    catch: (cause) => androidBackendError(cause, code, step),
    try: operation,
  });

export { performNativeAppFill as performAndroidFill } from "./native-app-fill.ts";

const cleanEnvironment = () => {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AGENT_DEVICE_")
    )
  );
  return environment;
};

/** Runs the bundled agent-device CLI against one private state directory. */
const agentDeviceCli = (
  packageRoot: string,
  stateDir: string,
  args: readonly string[]
) =>
  io(async (signal) => {
    const { stdout } = await execute(
      process.execPath,
      [
        path.join(packageRoot, "bin/agent-device.mjs"),
        ...args,
        "--state-dir",
        stateDir,
        "--json",
      ],
      {
        env: cleanEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        signal,
        timeout: 60_000,
      }
    );
    return stdout;
  });

/** A failed open leaves no session, so closing it has nothing to release. */
const closeAgentDeviceSession = <A>(
  close: (signal: AbortSignal) => Promise<A>
) =>
  io(async (signal) => {
    try {
      await close(signal);
    } catch (error) {
      if (isAgentDeviceError(error) && error.code === "SESSION_NOT_FOUND") {
        return;
      }
      throw error;
    }
  });

/** All ADB operations bind the exact selected serial. */
const adb = (serial: string, args: readonly string[]) => {
  const installing = args[0] === "install";
  return io(
    async (signal) => {
      const { stdout } = await execute("adb", ["-s", serial, ...args], {
        maxBuffer: 8 * 1024 * 1024,
        signal,
        // Package verification can outlast a normal command.
        // Wait for the installation process to exit, with a separate hang guard.
        timeout: installing ? 120_000 : 30_000,
      });
      return stdout.trim();
    },
    installing ? "installation_failed" : "device_disconnected"
  );
};

const decode = <A>(schema: Schema.Codec<A>, value: string) =>
  Effect.try({
    catch: () => platformRuntimeError("helper_incompatible"),
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(value)),
  });

const requireIdentity = (input: AndroidRuntimeStartInput) =>
  requireAndroidDeviceIdentity(input.device, (args) =>
    adb(input.device.serial, args)
  );

const installedHash = (
  serial: string,
  packageName: string = androidHelperRelease.packageName
) =>
  Effect.gen(function* readInstalledHelper() {
    const result = yield* adb(serial, [
      "shell",
      `pm path --user 0 ${packageName} || true`,
    ]);
    if (result === "") {
      return null;
    }
    const apk = packagePathPattern.exec(result)?.groups?.apk;
    if (apk === undefined) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
    return (
      (yield* adb(serial, ["shell", "sha256sum", apk])).split(/\s+/u)[0] ?? null
    );
  });

const escapedHelperPackage = androidHelperRelease.packageName.replaceAll(
  ".",
  String.raw`\.`
);
const helperVersionCodePattern = new RegExp(
  `^package:${escapedHelperPackage}\\s+versionCode:(?<versionCode>\\d+)\\s*$`,
  "mu"
);

/**
 * Android refuses to install an older versionCode over a newer one, so a newer
 * helper is refused with a reason before any installation is authorized.
 * `pm list packages` filters by substring; only the exact package line counts.
 */
export const requireReplaceableHelper = (packageList: string) =>
  Effect.gen(function* replaceableHelper() {
    const versionCode = Number(
      helperVersionCodePattern.exec(packageList)?.groups?.versionCode
    );
    if (!Number.isSafeInteger(versionCode)) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
    if (versionCode > androidHelperRelease.versionCode) {
      return yield* Effect.fail(platformRuntimeError("helper_newer_installed"));
    }
  });

/** Only a confirmed automatic grant may replace a newer helper. */
export const helperReplacement = (packageList: string, automatic: boolean) =>
  Effect.gen(function* replacement() {
    const result = yield* Effect.result(requireReplaceableHelper(packageList));
    if (result._tag === "Success") {
      return false;
    }
    if (result.failure.code === "helper_newer_installed" && automatic) {
      return true;
    }
    return yield* Effect.fail(result.failure);
  });

/** Called under the selected device lock, after verifying the bundled APK bytes. */
export const installAuthorizedAndroidHelper = (
  input: AndroidRuntimeStartInput,
  installed: string | null,
  apk: string,
  run: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>
) =>
  Effect.gen(function* installHelper() {
    if (installed !== androidHelperRelease.sha256) {
      const grant = input.installationGrant;
      const removeNewer =
        installed !== null &&
        (yield* helperReplacement(
          yield* run([
            "shell",
            `pm list packages --user 0 --show-versioncode ${androidHelperRelease.packageName}`,
          ]),
          grant?.replaceNewer === true &&
            grant.operation === "auto" &&
            grant.serial === input.device.serial &&
            grant.sha256 === androidHelperRelease.sha256
        ));
      if (
        grant?.serial !== input.device.serial ||
        grant.sha256 !== androidHelperRelease.sha256 ||
        (grant.operation !== "auto" &&
          grant.operation !== (installed === null ? "install" : "replace"))
      ) {
        return yield* Effect.fail(platformRuntimeError("installation_denied"));
      }
      if (removeNewer) {
        // Only the helper is disposable. Never uninstall the Target App.
        const removed = yield* run([
          "uninstall",
          androidHelperRelease.packageName,
        ]);
        if (removed !== "Success") {
          return yield* Effect.fail(
            platformRuntimeError("installation_failed")
          );
        }
      }
      yield* run([
        "install",
        "--user",
        "0",
        ...(installed === null || removeNewer ? [] : ["-r"]),
        apk,
      ]);
    }
  });

const requireHelper = (serial: string) =>
  Effect.gen(function* validateHelper() {
    // Exact signed APK bytes bind the signer and version as well as the payload.
    if ((yield* installedHash(serial)) !== androidHelperRelease.sha256) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
  });

/** Secure windows cannot provide usable evidence. */
const requireVisibleWindow = (input: AndroidRuntimeStartInput) =>
  Effect.gen(function* visibleWindow() {
    const windows = yield* adb(input.device.serial, [
      "shell",
      "dumpsys",
      "window",
    ]);
    const focus = focusPattern.exec(windows)?.groups;
    if (androidWindowVisibility(windows) === "secure") {
      return yield* Effect.fail(platformRuntimeError("secure_window"));
    }
    return focus?.window ?? "unknown";
  });

const requireCapture = (snapshot: CaptureSnapshotResult) =>
  Effect.gen(function* completeCapture() {
    const metadata = snapshot.androidSnapshot;
    if (
      metadata?.helperVersion !== androidHelperRelease.version ||
      metadata.helperApiVersion !== androidHelperRelease.api
    ) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
    if (
      metadata.captureMode !== "interactive-windows" ||
      metadata.rootPresent !== true ||
      metadata.helperTruncated !== false ||
      metadata.systemSurfaceOnly === true ||
      metadata.presentationFailure !== undefined ||
      metadata.missingRootWindowTypes === undefined ||
      metadata.missingRootWindowTypes.length !== 0 ||
      snapshot.truncated !== false ||
      snapshot.refsGeneration === undefined ||
      metadata.windowCount === undefined ||
      metadata.windowCount < 1
    ) {
      return yield* Effect.fail(platformRuntimeError("capture_incomplete"));
    }
    return {
      generation: snapshot.refsGeneration,
      windowCount: metadata.windowCount,
    };
  });

/** Isolated daemon, device lock, SDK session, and media are scope-owned. */
export const acquireAndroidBackend = (
  input: AndroidRuntimeStartInput,
  preparation?: AndroidRunInput
): Effect.Effect<AndroidRuntimeBackend, PlatformRuntimeError> =>
  Effect.gen(function* acquireBackend() {
    if (
      !serialPattern.test(input.device.serial) ||
      !packagePattern.test(input.targetApp)
    ) {
      return yield* Effect.fail(
        platformRuntimeError("device_selection_required")
      );
    }
    yield* requireIdentity(input);
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.resolve("agent-device"))),
      "../.."
    );
    yield* decode(
      Schema.Struct({ version: Schema.Literal(androidHelperRelease.version) }),
      yield* io(
        () => readFile(path.join(packageRoot, "package.json"), "utf-8"),
        "helper_incompatible"
      )
    );
    const manifest = yield* decode(
      ReleaseManifest,
      yield* io(
        () =>
          readFile(
            path.join(
              packageRoot,
              "android/snapshot-helper/dist/agent-device-android-snapshot-helper-0.21.25.manifest.json"
            ),
            "utf-8"
          ),
        "helper_incompatible"
      )
    );
    const apk = path.join(
      packageRoot,
      "android/snapshot-helper/dist/agent-device-android-snapshot-helper-0.21.25.apk"
    );
    const bytes = yield* io(() => readFile(apk), "helper_incompatible");
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
    const resources = yield* Scope.make("sequential");
    const cleanupRegistry = AtomRegistry.make();
    const cleanupFailure = Atom.make(false).pipe(Atom.keepAlive);
    cleanupRegistry.get(cleanupFailure);
    const finalize = (effect: Effect.Effect<unknown, PlatformRuntimeError>) =>
      effect.pipe(
        Effect.catchCause(() =>
          Effect.sync(() => cleanupRegistry.set(cleanupFailure, true))
        )
      );
    yield* Scope.addFinalizer(
      input.scope,
      Scope.close(resources, Exit.void).pipe(
        Effect.ensuring(Effect.sync(() => cleanupRegistry.dispose()))
      )
    );
    const acquired = Effect.gen(function* acquireOwnedResources() {
      // A cleanup failure keeps the lock while this process lives; once it
      // exits, the next start reclaims it.
      yield* Effect.acquireRelease(
        acquireAndroidDeviceLock(androidDeviceLockPath(input.device.serial)),
        (lock) =>
          cleanupRegistry.get(cleanupFailure)
            ? Effect.void
            : finalize(lock.release)
      );
      // The lock proves no live Contingency process uses this serial, so a
      // runtime a killed process left behind can be stopped before the check.
      yield* reclaimOrphanedAndroidRuntimes({
        adb: (args) => adb(input.device.serial, args),
        claimsDirectory: defaultAgentDeviceClaimsDirectory(),
        root: tmpdir(),
        serial: input.device.serial,
        stopDaemon: (stateDir) =>
          agentDeviceCli(packageRoot, stateDir, ["daemon", "stop"]),
      });
      const running = yield* adb(input.device.serial, [
        "shell",
        `pidof ${androidHelperRelease.packageName} || true`,
      ]);
      if (running !== "") {
        return yield* Effect.fail(platformRuntimeError("helper_owned"));
      }
      const installed = yield* installedHash(input.device.serial);
      yield* installAuthorizedAndroidHelper(input, installed, apk, (args) =>
        adb(input.device.serial, args)
      );
      yield* requireHelper(input.device.serial);
      // The explicitly authorized installation persists. Session cleanup never uninstalls it.
      const directory = yield* Effect.acquireRelease(
        io(() => mkdtemp(path.join(tmpdir(), ANDROID_RUNTIME_PREFIX))),
        (owned) =>
          cleanupRegistry.get(cleanupFailure)
            ? Effect.void
            : finalize(
                io(
                  () => rm(owned, { force: true, recursive: true }),
                  "cleanup_failed"
                )
              )
      );
      yield* io(() => chmod(directory, 0o700));
      // Written before the daemon starts, so a killed process's runtime is reclaimable.
      yield* writeAndroidRuntimeOwner(directory, input.device.serial).pipe(
        Effect.mapError(() => platformRuntimeError("runtime_failed"))
      );
      if (preparation !== undefined) {
        yield* prepareAndroidStartingState(preparation, directory);
      }
      const cli = (args: readonly string[]) =>
        agentDeviceCli(packageRoot, directory, args);
      // Register daemon cleanup before its first potentially spawning operation.
      yield* Scope.addFinalizer(resources, finalize(cli(["daemon", "stop"])));
      yield* cli([
        "devices",
        "--platform",
        "android",
        "--daemon-server-mode",
        "http",
      ]);
      const info = yield* decode(
        DaemonInfo,
        yield* io(() => readFile(path.join(directory, "daemon.json"), "utf-8"))
      );
      if (info.version !== manifest.version || info.stateDir !== directory) {
        return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
      }
      const sessionId = `contingency-android-${randomUUID()}`;
      const client = createAgentDeviceClient({
        cwd: directory,
        daemonAuthToken: info.token,
        daemonBaseUrl: `http://127.0.0.1:${info.httpPort}`,
        daemonTransport: "http",
        debug: false,
        responseLevel: "full",
        session: sessionId,
      });
      const options = () => ({
        platform: "android" as const,
        requestId: randomUUID(),
        serial: input.device.serial,
      });
      const identities = (identifiers: AgentDeviceIdentifiers | undefined) => {
        if (identifiers === undefined) {
          return Effect.void;
        }
        if (
          identifiers.serial !== input.device.serial ||
          identifiers.session !== sessionId
        ) {
          return Effect.fail(platformRuntimeError("device_mismatch"));
        }
        return Effect.void;
      };
      // Unique session ID is never adopted; cleanup is admitted only within this private daemon.
      yield* Scope.addFinalizer(
        resources,
        finalize(
          closeAgentDeviceSession((signal) => client.sessions.close({ signal }))
        )
      );
      const opened = yield* io((signal) =>
        client.apps.open({
          ...options(),
          foreground: false,
          noRecord: true,
          signal,
          testIme: false,
        })
      );
      yield* identities(opened.identifiers);
      const readSessionSerial = () =>
        Effect.gen(function* readSelectedSession() {
          const sessions = yield* io(
            (signal) => client.sessions.list({ signal }),
            "runtime_failed",
            "session-check"
          );
          const selected = sessions.find(
            (session) => session.name === sessionId
          );
          if (selected === undefined) {
            return null;
          }
          // An existing session without an Android binding is a mismatch, not absence.
          return selected.device.android?.serial ?? "";
        });
      const validateEnvironment = () =>
        requireIdentity(input).pipe(
          Effect.andThen(requireHelper(input.device.serial)),
          Effect.andThen(requireVisibleWindow(input)),
          Effect.andThen(
            preparation === undefined
              ? Effect.void
              : requireAndroidAppBuild(preparation).pipe(
                  Effect.andThen(
                    requireAndroidPermissionState(preparation, (args) =>
                      adb(input.device.serial, args)
                    )
                  )
                )
          )
        );
      const lifecycle = makeAndroidSessionLifecycle({
        close: () =>
          io((signal) => client.sessions.close({ signal })).pipe(Effect.asVoid),
        open: () =>
          Effect.gen(function* reopenSelectedSession() {
            const reopened = yield* io(
              (signal) =>
                client.apps.open({
                  ...options(),
                  foreground: false,
                  noRecord: true,
                  signal,
                  testIme: false,
                }),
              "runtime_failed",
              "open"
            );
            yield* identities(reopened.identifiers);
          }),
        readSerial: readSessionSerial,
        registry: cleanupRegistry,
        serial: input.device.serial,
        validateEnvironment,
      });
      const validate = () =>
        validateEnvironment().pipe(Effect.andThen(lifecycle.requireSession()));
      const fillPublic = client.interactions.fill.bind(client.interactions);
      const backend: AndroidRuntimeBackend = {
        activate: (ref) =>
          io(
            (signal) =>
              client.interactions.click({ ...options(), ref, signal }),
            "runtime_failed",
            "activate"
          ).pipe(Effect.asVoid),
        capture: () =>
          // The runtime validates the environment on its own cadence; the
          // device identity of each capture is still checked here.
          Effect.gen(function* captureAndroid() {
            const snapshot = yield* io(
              (signal) =>
                client.capture.snapshot({
                  ...options(),
                  interactiveOnly: false,
                  noRecord: true,
                  signal,
                }),
              "runtime_failed",
              "capture"
            );
            yield* identities(snapshot.identifiers);
            const { generation, windowCount } = yield* requireCapture(snapshot);
            for (const node of snapshot.nodes) {
              if (node.rect !== undefined) {
                yield* Schema.decodeUnknownEffect(AndroidElementBounds)(
                  node.rect
                ).pipe(
                  Effect.mapError(() =>
                    platformRuntimeError("capture_incomplete")
                  )
                );
              }
            }
            const target = (node: SnapshotNode) =>
              `@${node.ref.replace(/^@/u, "")}~s${generation}`;
            const id = randomUUID();
            const screenshotPath = path.join(
              directory,
              `observation-${id}.png`
            );
            const screenshot = yield* io(
              (signal) =>
                client.capture.screenshot({ path: screenshotPath, signal }),
              "runtime_failed",
              "screenshot"
            );
            yield* identities(screenshot.identifiers);
            const image = yield* io(() => readFile(screenshotPath));
            // SDK files and raw screenshots stay in the private session directory.
            const result: AndroidObservation = {
              backendSessionId: sessionId,
              capture: {
                complete: true,
                mode: "interactive-windows",
                secureWindowVisibility: "unverified",
                windowCount,
              },
              device: input.device,
              generation,
              id,
              nodes: snapshot.nodes.map((node, index) => {
                const observed: AndroidObservation["nodes"][number] = {
                  ...androidNodeInteraction(node),
                  name: androidNodeName(snapshot.nodes, index),
                  packageName: node.bundleId ?? null,
                  target: target(node),
                };
                if (node.rect === undefined) {
                  return observed;
                }
                return { ...observed, bounds: node.rect };
              }),
              ownership: {
                focusedPackage: input.targetApp,
                kind: "experimental-host-check",
                systemDialogAuthority: "unsupported",
              },
              platform: "android",
              screenshot: {
                capturedAt: new Date().toISOString(),
                encoding: "base64",
                format: "png",
                image: image.toString("base64"),
              },
            };
            return result;
          }),
        close: () =>
          Scope.close(resources, Exit.void).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                cleanupRegistry.get(cleanupFailure)
                  ? Effect.fail(platformRuntimeError("cleanup_failed"))
                  : Effect.void
              )
            )
          ),
        fill: (ref, text) =>
          performNativeAppFill((signal) =>
            fillPublic({ ...options(), ref, signal, text })
          ),
        recover: lifecycle.recover,
        sessionId,
        systemKey: (key) =>
          io(
            async (signal) => {
              const request = { ...options(), signal };
              if (key === "home") {
                await client.command.home(request);
              } else if (key === "app-switcher") {
                await client.command.appSwitcher(request);
              } else {
                await client.command.back(request);
              }
            },
            "runtime_failed",
            key
          ).pipe(Effect.asVoid),
        validate,
      };
      return backend;
    }).pipe(Scope.provide(resources));
    return yield* acquired.pipe(
      Effect.onError(() => Scope.close(resources, Exit.void))
    );
  });

export { closeAgentDeviceSession, io as androidRuntimeIo };
