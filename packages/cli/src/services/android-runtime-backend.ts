import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
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

import {
  requireAndroidDeviceIdentity,
  runAndroidOwnerCommand,
} from "./android-device-identity.ts";
import {
  prepareAndroidStartingState,
  requireAndroidAppBuild,
  requireAndroidClearDataConsent,
  requireAndroidPermissionState,
} from "./android-preparation.ts";
import {
  enterAndroidPrivateText,
  makeAndroidPrivateTextHost,
} from "./android-private-text.ts";
import type { AndroidRunInput } from "./android-run-contract.ts";
import {
  androidHelperRelease,
  androidPrivateTextRelease,
} from "./android-runtime-contract.ts";
import type {
  AndroidObservation,
  AndroidPrivateTextBinding,
  AndroidRuntimeBackend,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import { makeAndroidSessionLifecycle } from "./android-session-lifecycle.ts";
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

/** Never export child output or SDK errors, which may contain user data. */
const io = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  code: PlatformRuntimeError["code"] = "runtime_failed",
  step: NonNullable<PlatformRuntimeError["operation"]> = "host-io"
) =>
  Effect.tryPromise({
    catch: (cause): PlatformRuntimeError => {
      const error = { ...platformRuntimeError(code), operation: step };
      if (isAgentDeviceError(cause)) {
        const reason = cause.details?.reason;
        if (
          reason === "ref_generation_mismatch" ||
          reason === "stale_ref" ||
          reason === "device_not_found" ||
          reason === "request_canceled" ||
          reason === "android_text_input_unverified"
        ) {
          return { ...error, backendReason: reason };
        }
      }
      return error;
    },
    try: operation,
  });

const cleanEnvironment = (privateText: boolean) => {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AGENT_DEVICE_")
    )
  );
  if (privateText) {
    // Android allows one UiAutomation connection. One-shot capture releases it
    // between commands, so the private text helper can take its turn.
    environment.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION = "0";
  }
  return environment;
};

/** Built output keeps the helper under `dist/android`; a source checkout reads the package. */
export const resolvePrivateTextRelease = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "android", "private-text-helper")
    : path.resolve(
        moduleDirectory,
        "../../android/private-text-helper/release"
      );

/** All ADB operations bind the exact selected serial. */
const adb = (serial: string, args: readonly string[]) =>
  io(async (signal) => {
    const { stdout } = await execute("adb", ["-s", serial, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      signal,
      timeout: 30_000,
    });
    return stdout.trim();
  }, "device_disconnected");

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

const requireHelper = (serial: string) =>
  Effect.gen(function* validateHelper() {
    // Exact signed APK bytes bind the signer and version as well as the payload.
    if ((yield* installedHash(serial)) !== androidHelperRelease.sha256) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
  });

const requirePrivateTextHelper = (serial: string) =>
  Effect.gen(function* validatePrivateTextHelper() {
    if (
      (yield* installedHash(serial, androidPrivateTextRelease.packageName)) !==
      androidPrivateTextRelease.sha256
    ) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
  });

/** Returns the focused window, which must belong to the target app. */
const requireOwnership = (input: AndroidRuntimeStartInput) =>
  Effect.gen(function* ownership() {
    const windows = yield* adb(input.device.serial, [
      "shell",
      "dumpsys",
      "window",
    ]);
    const focus = focusPattern.exec(windows)?.groups;
    if (focus?.packageName !== input.targetApp || focus.window === undefined) {
      return yield* Effect.fail(platformRuntimeError("ownership_unknown"));
    }
    if (focus.userId !== "0") {
      return yield* Effect.fail(
        platformRuntimeError("user_profile_unsupported")
      );
    }
    return focus.window;
  });

const publicNodeName = (node: SnapshotNode, targetApp: string) => {
  if (node.bundleId !== targetApp) {
    return "Other window";
  }
  if (node.password === true) {
    return "Private field";
  }
  return node.label ?? "";
};

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

const PrivateTextManifest = Schema.Struct({
  apk: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+\.apk$/u)),
  instrumentation: Schema.Literal(androidPrivateTextRelease.instrumentation),
  packageName: Schema.Literal(androidPrivateTextRelease.packageName),
  protocol: Schema.Literal(androidPrivateTextRelease.protocol),
  sha256: Schema.Literal(androidPrivateTextRelease.sha256),
  signingCertificateSha256: Schema.Literal(
    androidPrivateTextRelease.signingCertificateSha256
  ),
  version: Schema.Literal(androidPrivateTextRelease.version),
  versionCode: Schema.Literal(androidPrivateTextRelease.versionCode),
});

/** Installs the pinned private text helper only under an exact grant. */
const installPrivateTextHelper = (input: AndroidRuntimeStartInput) =>
  Effect.gen(function* installPrivateText() {
    const release = resolvePrivateTextRelease(import.meta.dirname);
    const manifest = yield* decode(
      PrivateTextManifest,
      yield* io(
        () => readFile(path.join(release, "manifest.json"), "utf-8"),
        "helper_incompatible"
      )
    );
    const apk = path.join(release, manifest.apk);
    const bytes = yield* io(() => readFile(apk), "helper_incompatible");
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
      return yield* Effect.fail(platformRuntimeError("helper_incompatible"));
    }
    const installed = yield* installedHash(
      input.device.serial,
      androidPrivateTextRelease.packageName
    );
    if (installed === manifest.sha256) {
      return;
    }
    const grant = input.privateTextGrant;
    if (
      grant?.serial !== input.device.serial ||
      grant.sha256 !== manifest.sha256 ||
      grant.operation !== (installed === null ? "install" : "replace")
    ) {
      return yield* Effect.fail(platformRuntimeError("installation_denied"));
    }
    yield* runAndroidOwnerCommand(
      (args) => adb(input.device.serial, args),
      ["install", "--user", "0", ...(installed === null ? [] : ["-r"]), apk]
    );
    yield* requirePrivateTextHelper(input.device.serial);
  });

const privateTextBinding = (
  node: SnapshotNode,
  focusedWindow: string
): AndroidPrivateTextBinding | null => {
  const { rect } = node;
  if (
    node.editable !== true ||
    node.password !== true ||
    node.bundleId === undefined ||
    node.type === undefined ||
    rect === undefined
  ) {
    return null;
  }
  return {
    bounds: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    className: node.type,
    focusedWindow,
    packageName: node.bundleId,
    password: node.password === true,
    resourceId: node.identifier ?? null,
  };
};

/** Isolated daemon, device lock, SDK session, and media are scope-owned. */
export const acquireAndroidBackend = (
  input: AndroidRuntimeStartInput,
  preparation?: AndroidRunInput
): Effect.Effect<AndroidRuntimeBackend, PlatformRuntimeError> =>
  Effect.gen(function* acquireBackend() {
    const privateText = input.requiredCapabilities.includes("private-input");
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
    if (preparation !== undefined) {
      yield* requireAndroidClearDataConsent(preparation);
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
      const lockPath = path.join(
        tmpdir(),
        `contingency-android-${createHash("sha256").update(input.device.serial).digest("hex")}.lock`
      );
      yield* Effect.acquireRelease(
        io(() => mkdir(lockPath, { mode: 0o700 }), "helper_owned"),
        () =>
          cleanupRegistry.get(cleanupFailure)
            ? Effect.void
            : finalize(io(() => rmdir(lockPath), "cleanup_failed"))
      );
      const running = yield* adb(input.device.serial, [
        "shell",
        `pidof ${androidHelperRelease.packageName} || true`,
      ]);
      if (running !== "") {
        return yield* Effect.fail(platformRuntimeError("helper_owned"));
      }
      const installed = yield* installedHash(input.device.serial);
      if (installed !== manifest.sha256) {
        const grant = input.installationGrant;
        if (
          grant?.serial !== input.device.serial ||
          grant.sha256 !== manifest.sha256 ||
          grant.operation !== (installed === null ? "install" : "replace")
        ) {
          return yield* Effect.fail(
            platformRuntimeError("installation_denied")
          );
        }
        yield* runAndroidOwnerCommand(
          (args) => adb(input.device.serial, args),
          ["install", "--user", "0", ...(installed === null ? [] : ["-r"]), apk]
        );
        yield* requireHelper(input.device.serial);
      }
      if (privateText) {
        yield* installPrivateTextHelper(input);
      }
      // The explicitly authorized installation persists. Session cleanup never uninstalls it.
      const directory = yield* Effect.acquireRelease(
        io(() => mkdtemp(path.join(tmpdir(), "contingency-android-runtime-"))),
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
      if (preparation !== undefined) {
        yield* prepareAndroidStartingState(preparation, directory);
      }
      const cli = (args: readonly string[]) =>
        io(async (signal) => {
          const { stdout } = await execute(
            process.execPath,
            [
              path.join(packageRoot, "bin/agent-device.mjs"),
              ...args,
              "--state-dir",
              directory,
              "--json",
            ],
            {
              env: cleanEnvironment(privateText),
              maxBuffer: 8 * 1024 * 1024,
              signal,
              timeout: 60_000,
            }
          );
          return stdout;
        });
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
        finalize(io((signal) => client.sessions.close({ signal })))
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
          Effect.andThen(
            privateText
              ? requirePrivateTextHelper(input.device.serial)
              : Effect.void
          ),
          Effect.andThen(requireOwnership(input)),
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
      // Bound fields of the latest capture only; each capture replaces them.
      const privateTargets = Atom.make<
        ReadonlyMap<string, AndroidPrivateTextBinding>
      >(new Map()).pipe(Atom.keepAlive);
      cleanupRegistry.get(privateTargets);
      const privateTextHost = makeAndroidPrivateTextHost(
        input.device.serial,
        (args) => adb(input.device.serial, args)
      );
      const backend: AndroidRuntimeBackend = {
        activate: (ref) =>
          io(
            (signal) =>
              client.interactions.click({ ...options(), ref, signal }),
            "runtime_failed",
            "activate"
          ).pipe(Effect.asVoid),
        back: () =>
          io(
            (signal) => client.command.back({ ...options(), signal }),
            "runtime_failed",
            "back"
          ).pipe(Effect.asVoid),
        capture: () =>
          Effect.gen(function* captureAndroid() {
            cleanupRegistry.set(privateTargets, new Map());
            yield* validate();
            // Fields bind to a window only when it stayed focused across the snapshot.
            const windowBefore = privateText
              ? yield* requireOwnership(input)
              : null;
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
            if (
              (snapshot.appBundleId !== undefined &&
                snapshot.appBundleId !== input.targetApp) ||
              !snapshot.nodes.some((node) => node.bundleId === input.targetApp)
            ) {
              return yield* Effect.fail(
                platformRuntimeError("ownership_unknown")
              );
            }
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
            yield* validate();
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
              nodes: snapshot.nodes.map((node) => {
                const observed: AndroidObservation["nodes"][number] = {
                  covered:
                    node.interactionBlocked === "covered" ||
                    node.enabled === false,
                  editable: node.editable === true,
                  name: publicNodeName(node, input.targetApp),
                  packageName: node.bundleId ?? null,
                  password: node.password === true,
                  role: node.kind ?? node.role ?? node.type ?? "unknown",
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
            const focusedWindow = privateText
              ? yield* requireOwnership(input)
              : null;
            if (focusedWindow !== null && focusedWindow === windowBefore) {
              cleanupRegistry.set(
                privateTargets,
                new Map(
                  snapshot.nodes.flatMap((node) => {
                    const binding = privateTextBinding(node, focusedWindow);
                    return binding === null ? [] : [[target(node), binding]];
                  })
                )
              );
            }
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
        enterPrivate: (ref, value) =>
          Effect.gen(function* enterPrivate() {
            const binding = cleanupRegistry.get(privateTargets).get(ref);
            cleanupRegistry.set(privateTargets, new Map());
            if (!privateText || binding === undefined) {
              return yield* Effect.fail(
                platformRuntimeError("target_unsupported")
              );
            }
            yield* validate();
            // A different focused window means the observed field may be gone.
            const requireWindow = requireOwnership(input).pipe(
              Effect.flatMap((window) =>
                window === binding.focusedWindow
                  ? Effect.void
                  : Effect.fail(platformRuntimeError("target_changed"))
              )
            );
            yield* enterAndroidPrivateText(privateTextHost, {
              binding,
              requireWindow,
              targetApp: input.targetApp,
              value,
            }).pipe(
              // Retain the device lock: a helper process or forward may remain.
              Effect.tapError((error) =>
                error.code === "cleanup_failed"
                  ? Effect.sync(() => cleanupRegistry.set(cleanupFailure, true))
                  : Effect.void
              )
            );
          }),
        fill: (ref, text) =>
          io((signal) => fillPublic({ ...options(), ref, signal, text })).pipe(
            Effect.asVoid
          ),
        recover: lifecycle.recover,
        sessionId,
        validate,
      };
      return backend;
    }).pipe(Scope.provide(resources));
    return yield* acquired.pipe(
      Effect.onError(() => Scope.close(resources, Exit.void))
    );
  });
