import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  IosWorkspaceSelection,
  PlatformRequirements,
} from "@contingency/protocol";
import { createAgentDeviceClient, isAgentDeviceError } from "agent-device";
import type {
  AgentDeviceIdentifiers,
  CaptureSnapshotOptions,
  AppOpenOptions,
} from "agent-device";
import { Effect, Exit, Predicate, Ref, Schedule, Scope } from "effect";

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
const identifier = /^[\w-]+$/u;
/** Name the failed step and agent-device's code and reason; never its message, which may carry user data. */
export const iosAgentDeviceFailure = (
  cause: unknown,
  code: PlatformRuntimeError["code"],
  operation: NonNullable<PlatformRuntimeError["operation"]>
): PlatformRuntimeError => {
  const failure = (detail: readonly unknown[]): PlatformRuntimeError => {
    const named = detail
      .filter(
        (part): part is string =>
          Predicate.isString(part) && identifier.test(part)
      )
      .join(", ");
    return {
      ...iosRuntimeError(code),
      message: `iOS ${code} during ${operation}${named === "" ? "" : ` (${named})`}. Inspect this session and explicitly recover before input.`,
      operation,
    };
  };
  if (!isAgentDeviceError(cause)) {
    return failure([]);
  }
  const reason = cause.details?.reason;
  const error = failure([cause.code, reason]);
  return reason === "ref_generation_mismatch" ||
    reason === "stale_ref" ||
    reason === "device_not_found" ||
    reason === "request_canceled" ||
    reason === "input_unverified"
    ? { ...error, backendReason: reason }
    : error;
};
/** agent-device refuses one presentation when the runner reports no usable viewport; observe again as for a cut-short tree. */
export const iosSnapshotFailure = (cause: unknown): PlatformRuntimeError => {
  const reason = isAgentDeviceError(cause) ? cause.details?.reason : undefined;
  if (isAgentDeviceError(cause) && cause.code === "OBSERVATION_UNAVAILABLE") {
    return {
      ...iosAgentDeviceFailure(cause, "foreign_app_foreground", "capture"),
      message:
        "iOS cannot observe the Target App while another app is in front. Choose Return to Target App to continue on this selected simulator.",
    };
  }
  return iosAgentDeviceFailure(
    cause,
    reason === "invalid-viewport" || reason === "missing-viewport"
      ? "observation_stale"
      : "runtime_failed",
    "capture"
  );
};
const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  operation: NonNullable<PlatformRuntimeError["operation"]>,
  code: PlatformRuntimeError["code"] = "runtime_failed"
) =>
  Effect.tryPromise({
    catch: (cause) => iosAgentDeviceFailure(cause, code, operation),
    try: run,
  });
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
interface IosViewport {
  readonly width: number;
  readonly height: number;
}
/** A presented system alert's frame arrives as the viewport while its rects stay in window points; keep the window it sits inside. */
export const iosWindowViewport = (
  snapshot: {
    readonly viewport: IosViewport;
    readonly nodes: readonly {
      readonly rect?: IosViewport & { readonly x: number; readonly y: number };
    }[];
  },
  window: IosViewport | null
): IosViewport => {
  const root = snapshot.nodes[0]?.rect;
  const presented =
    window !== null &&
    root !== undefined &&
    root.width === snapshot.viewport.width &&
    root.height === snapshot.viewport.height &&
    (root.x !== 0 || root.y !== 0) &&
    root.x >= 0 &&
    root.y >= 0 &&
    root.x + root.width <= window.width &&
    root.y + root.height <= window.height;
  return presented ? window : snapshot.viewport;
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

type IosSessionAppState = Awaited<
  ReturnType<ReturnType<typeof createAgentDeviceClient>["command"]["appState"]>
>;

/** Check the session app after the screenshot, which can outlive a foreground transition. */
export const iosAppStateProblem = (
  state: IosSessionAppState,
  udid: string,
  bundle: string
): PlatformRuntimeError["code"] | null => {
  if (state.platform !== "ios" || state.device_udid !== udid) {
    return "device_mismatch";
  }
  if (state.appBundleId !== bundle) {
    return "target_changed";
  }
  if (state.source !== "runner" || state.state === undefined) {
    return "capture_incomplete";
  }
  if (
    state.state === "runningBackground" ||
    state.state === "runningBackgroundSuspended"
  ) {
    return "foreign_app_foreground";
  }
  return state.state === "runningForeground" ? null : "runtime_failed";
};

/** Session-bound SDK access shared by Teaching, Dry Runs, and Runs. */
export const makeIosSessionAccess = <A, B>(input: {
  readonly snapshot: (options: CaptureSnapshotOptions) => Promise<A>;
  readonly open: (options: AppOpenOptions) => Promise<B>;
  readonly options: () => {
    readonly platform: "ios";
    readonly udid: string;
    readonly requestId: string;
  };
  readonly targetApp: string;
}) => ({
  recover: () =>
    io(
      (signal) =>
        input.open({
          ...input.options(),
          app: input.targetApp,
          noRecord: true,
          relaunch: false,
          signal,
        }),
      "open"
    ).pipe(Effect.asVoid),
  snapshot: () =>
    Effect.tryPromise({
      catch: iosSnapshotFailure,
      try: (signal) =>
        input.snapshot({
          ...input.options(),
          interactiveOnly: false,
          noRecord: true,
          observeOnly: true,
          signal,
        }),
    }),
});

interface IosScreen {
  readonly nodes: readonly Pick<
    IosObservation["nodes"][number],
    "role" | "name"
  >[];
}
const screenLabels = (screen: IosScreen) =>
  screen.nodes.map(({ role, name }) => JSON.stringify([role, name]));

/** A new control or label proves screen progress. Generation, geometry, and
 * disappearing nodes do not: the measured stale Settings tree lost a label.
 * Keep the three-capture bound for those suspicious screens, without sleeps.
 * Any refusal stops immediately; return only the latest observation.
 */
export const observeIosPostAction = <A extends IosScreen, E, R>(
  observe: Effect.Effect<A, E, R>,
  before: IosScreen
) =>
  Effect.gen(function* observePostAction() {
    const previous = new Set(screenLabels(before));
    let after = yield* observe;
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      if (screenLabels(after).some((label) => !previous.has(label))) {
        return after;
      }
      after = yield* observe;
    }
    return after;
  });

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
          const sessions = yield* io(
            (signal) => client.sessions.list({ signal }),
            "session-check"
          );
          const bound = sessions.find((entry) => entry.name === session);
          if (bound?.device.ios?.udid !== udid) {
            return yield* Effect.fail(iosRuntimeError("device_mismatch"));
          }
        });
      const access = makeIosSessionAccess({
        open: client.apps.open.bind(client.apps),
        options,
        snapshot: client.capture.snapshot.bind(client.capture),
        targetApp: input.targetApp,
      });
      const fillPublic = client.interactions.fill.bind(client.interactions);
      const window = yield* Ref.make<IosViewport | null>(null);
      const captureOnce = () =>
        Effect.gen(function* captureIos() {
          yield* validate();
          const snapshot = yield* access.snapshot();
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
          const viewport = iosWindowViewport(
            { nodes: snapshot.nodes, viewport: snapshot.viewport },
            yield* Ref.get(window)
          );
          const id = randomUUID();
          const filename = path.join(
            prepared.directory,
            `observation-${id}.png`
          );
          const screenshot = yield* io(
            (signal) =>
              client.capture.screenshot({
                ...options(),
                path: filename,
                signal,
              }),
            "screenshot"
          );
          yield* identities(screenshot.identifiers, udid, session);
          const appState = yield* io(
            (signal) => client.command.appState({ ...options(), signal }),
            "session-check"
          );
          const stateProblem = iosAppStateProblem(
            appState,
            udid,
            input.targetApp
          );
          if (stateProblem !== null) {
            return yield* Effect.fail(iosRuntimeError(stateProblem));
          }
          yield* validate();
          const bytes = yield* io(() => readFile(filename), "host-io");
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
            Math.sign(viewport.width - viewport.height)
          ) {
            return yield* Effect.fail(iosRuntimeError("observation_stale"));
          }
          yield* Ref.set(window, viewport);
          const sx = width / viewport.width;
          const sy = height / viewport.height;
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
            io(
              (signal) =>
                client.interactions.click({
                  ...options(),
                  ref: target,
                  signal,
                }),
              "activate"
            ).pipe(Effect.asVoid),
          capture,
          close: () => Scope.close(resources, Exit.void),
          fill: (target, text) =>
            performNativeAppFill(
              (signal) =>
                fillPublic({ ...options(), ref: target, signal, text }),
              iosRuntimeError
            ),
          recover: () => validate().pipe(Effect.andThen(access.recover())),
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

export const iosRunDecisions = (
  request: IosRunInput,
  runId: string
): readonly NativeAppRunDecision[] => [
  ...(request.taught.platform === "ios"
    ? iosEnvironmentPermission(
        runId,
        request.taught.environment,
        request.environment
      )
    : []),
  ...(request.appPath === undefined
    ? []
    : [
        {
          differences: [],
          id: randomUUID(),
          kind: "app-installation" as const,
          runId,
          targetApp: request.targetApp,
        },
      ]),
];

export const createIosRun = (
  input: IosRunInput
): Effect.Effect<IosRun, PlatformRuntimeError> =>
  createNativeAppRun(input, {
    authorize: (request) => request,
    decisions: iosRunDecisions,
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
        .requireRunning(request.device)
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
