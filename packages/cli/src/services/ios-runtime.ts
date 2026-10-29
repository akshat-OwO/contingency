import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  IosWorkspaceSelection,
  PlatformRequirements,
} from "@contingency/protocol";
import { createAgentDeviceClient } from "agent-device";
import type { AgentDeviceIdentifiers } from "agent-device";
import { Effect, Exit, Schedule, Scope } from "effect";

import type { AndroidObservation } from "./android-runtime-contract.ts";
import type { IosDevice } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import {
  compareIosEnvironments,
  iosEnvironmentPermission,
} from "./ios-environment.ts";
import { verifyIosFramebufferRelease } from "./ios-framebuffer-release.ts";
import { iosNodeInteraction } from "./ios-observation.ts";
import { makeIosPreparation } from "./ios-preparation.ts";
import { nativeAppActionPolicy } from "./native-app-action-policy.ts";
import { performNativeAppFill } from "./native-app-fill.ts";
import type {
  NativeAppRun,
  NativeAppRunDecision,
  NativeAppRunInput,
  NativeAppRunState,
} from "./native-app-run-contract.ts";
import { createNativeAppRun } from "./native-app-run.ts";
import type { NativeAppRuntime } from "./native-app-runtime-contract.ts";
import { adaptNativeAppRuntime } from "./native-app-runtime.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

export interface IosObservation extends Omit<
  AndroidObservation,
  "platform" | "device" | "capture" | "ownership"
> {
  readonly platform: "ios";
  readonly device: IosDevice;
  readonly appId: string | null;
}
export interface IosRunInput extends NativeAppRunInput {
  readonly platform: "ios";
  readonly device: IosDevice;
  readonly environment: IosWorkspaceSelection["environment"];
  readonly setup: IosWorkspaceSelection["setup"];
  readonly appPath?: string;
  readonly taught: PlatformRequirements;
}
export type IosRun = NativeAppRun<
  IosObservation,
  NativeAppRunState<IosRunInput, NativeAppRunDecision>
>;
export const iosCapabilities = [
  "semantic-actions",
  "screenshots",
  "teaching-capture",
  "private-input",
] as const;
export const iosRuntimeError = (
  code: PlatformRuntimeError["code"]
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: `iOS ${code}. Inspect this session and explicitly recover before input.`,
});
const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  code: PlatformRuntimeError["code"] = "runtime_failed"
) => Effect.tryPromise({ catch: () => iosRuntimeError(code), try: run });
const identities = (
  id: AgentDeviceIdentifiers | undefined,
  udid: string,
  session: string
) =>
  id === undefined || (id.udid === udid && id.session === session)
    ? Effect.void
    : Effect.fail(iosRuntimeError("device_mismatch"));

/** A truncated tree is observed again: AutoFill's out-of-process sheet after a sign-in cuts one capture short. */
export const iosSnapshotProblem = (snapshot: {
  readonly truncated?: boolean;
  readonly viewport?: unknown;
  readonly refsGeneration?: number;
}): PlatformRuntimeError["code"] | null => {
  if (!snapshot.viewport || snapshot.refsGeneration === undefined) {
    return "capture_incomplete";
  }
  return snapshot.truncated === true ? "observation_stale" : null;
};
/** Re-observe a stale or cut-short capture; never act on mixed coordinate spaces or a partial tree. */
export const settleIosCapture = <A>(
  captureOnce: Effect.Effect<A, PlatformRuntimeError>
) =>
  captureOnce.pipe(
    Effect.retry({
      schedule: Schedule.spaced("250 millis"),
      while: (cause) => cause.code === "observation_stale",
    }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(iosRuntimeError("capture_incomplete")),
    })
  );

const startIosRuntime = (
  input: IosRunInput
): Effect.Effect<NativeAppRuntime<IosObservation>, PlatformRuntimeError> =>
  Effect.gen(function* startIos() {
    const resources = yield* Scope.make();
    yield* Scope.addFinalizer(input.scope, Scope.close(resources, Exit.void));
    return yield* Effect.gen(function* acquireIos() {
      const prepared = yield* makeIosPreparation()
        .prepare(input)
        .pipe(Effect.mapError((cause) => iosRuntimeError(cause.code)));
      const { udid } = prepared.device;
      const session = `contingency-ios-${udid}`;
      const client = createAgentDeviceClient({
        cwd: prepared.directory,
        daemonAuthToken: "",
        daemonBaseUrl: "",
        daemonServerMode: "socket",
        daemonTransport: "socket",
        debug: false,
        responseLevel: "full",
        session,
        stateDir: prepared.directory,
      });
      const options = () => ({
        platform: "ios" as const,
        requestId: randomUUID(),
        udid,
      });
      const validate = () =>
        Effect.gen(function* validateIos() {
          const sessions = yield* io((signal) =>
            client.sessions.list({ signal })
          );
          const bound = sessions.find((entry) => entry.name === session);
          if (bound?.device.ios?.udid !== udid) {
            return yield* Effect.fail(iosRuntimeError("device_mismatch"));
          }
        });
      const fillPublic = client.interactions.fill.bind(client.interactions);
      const captureOnce = () =>
        Effect.gen(function* captureIos() {
          yield* validate();
          const snapshot = yield* io((signal) =>
            client.capture.snapshot({
              ...options(),
              interactiveOnly: false,
              noRecord: true,
              signal,
            })
          );
          yield* identities(snapshot.identifiers, udid, session);
          const problem = iosSnapshotProblem(snapshot);
          if (
            problem !== null ||
            !snapshot.viewport ||
            snapshot.refsGeneration === undefined
          ) {
            return yield* Effect.fail(
              iosRuntimeError(problem ?? "capture_incomplete")
            );
          }
          const id = randomUUID();
          const filename = path.join(
            prepared.directory,
            `observation-${id}.png`
          );
          const screenshot = yield* io((signal) =>
            client.capture.screenshot({ ...options(), path: filename, signal })
          );
          yield* identities(screenshot.identifiers, udid, session);
          yield* validate();
          const bytes = yield* io(() => readFile(filename));
          if (
            bytes.length < 24 ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ) {
            return yield* Effect.fail(iosRuntimeError("capture_incomplete"));
          }
          const width = bytes.readUInt32BE(16);
          const height = bytes.readUInt32BE(20);
          if (
            Math.sign(width - height) !==
            Math.sign(snapshot.viewport.width - snapshot.viewport.height)
          ) {
            return yield* Effect.fail(iosRuntimeError("observation_stale"));
          }
          const sx = width / snapshot.viewport.width;
          const sy = height / snapshot.viewport.height;
          const observation: IosObservation = {
            appId: snapshot.appBundleId ?? null,
            backendSessionId: session,
            device: prepared.device,
            generation: snapshot.refsGeneration,
            id,
            nodes: snapshot.nodes.map((node) => {
              const interaction = iosNodeInteraction(node);
              const observed: IosObservation["nodes"][number] = {
                ...interaction,
                name: node.label ?? node.value ?? node.identifier ?? "",
                packageName: node.bundleId ?? snapshot.appBundleId ?? null,
                target: `@${node.ref.replace(/^@/u, "")}~s${snapshot.refsGeneration}`,
              };
              return node.rect === undefined
                ? observed
                : {
                    ...observed,
                    bounds: {
                      height: node.rect.height * sy,
                      width: node.rect.width * sx,
                      x: node.rect.x * sx,
                      y: node.rect.y * sy,
                    },
                  };
            }),
            platform: "ios",
            screenshot: {
              capturedAt: new Date().toISOString(),
              encoding: "base64",
              format: "png",
              image: bytes.toString("base64"),
            },
          };
          return observation;
        });
      const capture = () => settleIosCapture(captureOnce());
      return yield* adaptNativeAppRuntime({
        backend: {
          activate: (target) =>
            io((signal) =>
              client.interactions.click({ ...options(), ref: target, signal })
            ).pipe(Effect.asVoid),
          capture,
          close: () => Scope.close(resources, Exit.void),
          fill: (target, text) =>
            performNativeAppFill(
              (signal) =>
                fillPublic({ ...options(), ref: target, signal, text }),
              iosRuntimeError
            ),
          recover: validate,
          sessionId: session,
          validate,
        },
        capabilities: iosCapabilities,
        error: iosRuntimeError,
        policy: nativeAppActionPolicy(iosRuntimeError, false),
        startup: { ...input, device: prepared.device },
      });
    }).pipe(
      Scope.provide(resources),
      Effect.onError(() => Scope.close(resources, Exit.void))
    );
  });

export const createIosRun = (
  input: IosRunInput
): Effect.Effect<IosRun, PlatformRuntimeError> =>
  createNativeAppRun(input, {
    authorize: (request) => request,
    decisions: (request, runId) =>
      request.taught.platform === "ios"
        ? iosEnvironmentPermission(
            runId,
            request.taught.environment,
            request.environment
          )
        : [],
    differences: (request) =>
      request.taught.platform === "ios"
        ? compareIosEnvironments(
            request.taught.environment,
            request.environment
          )
        : [],
    error: iosRuntimeError,
    preflight: (request) =>
      makeIosDiscovery()
        .resolve(request.device)
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => iosRuntimeError(cause.code)),
          Effect.andThen(verifyIosFramebufferRelease()),
          Effect.asVoid
        ),
    start: startIosRuntime,
    startingConditions: (request, observation) =>
      request.setup.conditions.every((condition) =>
        observation.nodes.some(
          (node) =>
            !node.covered &&
            !node.password &&
            node.role === condition.role &&
            node.name === condition.name
        )
      ),
    validate: (request) =>
      request.taught.platform === "ios" &&
      request.requiredCapabilities.every((capability) =>
        iosCapabilities.some((supported) => supported === capability)
      ) &&
      request.environment.bundleId === request.targetApp
        ? Effect.void
        : Effect.fail(iosRuntimeError("capability_missing")),
  });
