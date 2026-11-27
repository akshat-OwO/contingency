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
  AlertCommandOptions,
  AppErrorDetails,
  AppOpenOptions,
  AppStateCommandOptions,
  CaptureSnapshotOptions,
  CommandRequestResult,
} from "agent-device";
import {
  Clock,
  Effect,
  Exit,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Scope,
} from "effect";

import type { AndroidObservation } from "./android-runtime-contract.ts";
import { supportsIosPermissions } from "./ios-contract.ts";
import type { IosDevice, IosError } from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import {
  compareIosEnvironments,
  iosEnvironmentPermission,
} from "./ios-environment.ts";
import {
  SPRINGBOARD,
  fillsScreen,
  followForeground,
  iosHostProcesses,
  makeIosForegroundGuess,
  springboardForeground,
} from "./ios-foreground.ts";
import type { ForegroundStep } from "./ios-foreground.ts";
import { verifyIosFramebufferRelease } from "./ios-framebuffer-release.ts";
import {
  iosActivationPoint,
  iosNodeInteraction,
  iosNodeName,
} from "./ios-observation.ts";
import { makeIosPreparation, restartIosTargetApp } from "./ios-preparation.ts";
import { iosSimctlHost } from "./ios-simctl.ts";
import { nativeAppActionPolicy } from "./native-app-action-policy.ts";
import { performNativeAppFill } from "./native-app-fill.ts";
import type {
  NativeAppRun,
  NativeAppRunDecision,
  NativeAppRunInput,
  NativeAppRunState,
} from "./native-app-run-contract.ts";
import { clearAppDataDecision, createNativeAppRun } from "./native-app-run.ts";
import type {
  NativeAppRuntime,
  NativeCaptureOptions,
} from "./native-app-runtime-contract.ts";
import { adaptNativeAppRuntime } from "./native-app-runtime.ts";
import { makeAgentDeviceScreenRecorder } from "./native-screen-recorder.ts";
import {
  failFromTyped,
  failReferenced,
  tryBackend,
} from "./platform-runtime-error.ts";
import type {
  NativeSystemKey,
  PlatformRuntimeError,
} from "./platform-runtime.ts";

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
  /** The Target App build on the simulator before installing `appPath`. */
  readonly installedBuild?: string | null;
  readonly taught: PlatformRequirements;
}
export type IosRun = NativeAppRun<
  IosObservation,
  NativeAppRunState<IosRunInput, NativeAppRunDecision>
>;
export interface IosRunDriver {
  readonly preflight: (
    input: IosRunInput,
    phase?: "installed"
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly start: (
    input: IosRunInput
  ) => Effect.Effect<NativeAppRuntime<IosObservation>, PlatformRuntimeError>;
  /** Restarts the prepared Target App under its Starting Data. */
  readonly restart?: (
    input: IosRunInput
  ) => Effect.Effect<void, PlatformRuntimeError>;
  /** The Target App build on the simulator, read before an installation decision. */
  readonly installedBuild?: (
    input: IosRunInput
  ) => Effect.Effect<string | null, PlatformRuntimeError>;
}
export const iosCapabilities = [
  "semantic-actions",
  "screenshots",
  "teaching-capture",
  "private-input",
] as const;
/** iOS has no system Back (ADR 0066); Home and the App Switcher go through agent-device. */
export const iosSystemKeys: readonly NativeSystemKey[] = [
  "home",
  "app-switcher",
];
const observedStep = <A>(value: A): ForegroundStep<A> => ({
  _tag: "observed",
  value,
});
const followStep = (app: string): ForegroundStep<never> => ({
  _tag: "follow",
  app,
});
export const iosRuntimeError = (
  code: PlatformRuntimeError["code"]
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: `iOS ${code}. Inspect this session and explicitly recover before input.`,
});
/** Local validation failures have no SDK error; name the exact check instead. */
export const iosCaptureFailure = (
  code: PlatformRuntimeError["code"],
  operation: NonNullable<PlatformRuntimeError["operation"]>,
  reason:
    | "snapshot-metadata"
    | "app-state-unverified"
    | "png-header"
    | "settle-deadline"
    | "alert-dismissed"
    | "foreground-handoff"
): PlatformRuntimeError => ({
  ...iosRuntimeError(code),
  message: `iOS ${code} during ${operation} (${reason}). Inspect this session and explicitly recover before input.`,
  operation,
});

/** Readings of a handoff, spaced to outlast an app switch or a dismissed alert. */
export const IOS_HANDOFF_READINGS = 20;
export const IOS_HANDOFF_SPACING = "250 millis";

/** The bound app's state as the runner reports it, or unverified without live runner evidence. */
export type IosHandoffState = "front" | "left" | "unverified";

/** Read the runner's live app state; session metadata alone proves nothing. */
export const iosHandoffState = (state: IosSessionAppState): IosHandoffState => {
  if (
    state.platform !== "ios" ||
    state.source !== "runner" ||
    state.state === undefined
  ) {
    return "unverified";
  }
  return state.state === "runningForeground" ? "front" : "left";
};

/**
 * The runner refused the bound app because it is handing off the foreground.
 * Reading its tree again through XCTest can hold the runner for a minute, and
 * binding another app activates it, so wait on its app state instead. Once it
 * leaves the front, follow a clear guess, or none to report the foreground
 * unknown. A handoff the runner keeps verifying in front is read again once,
 * since an alert being dismissed looks the same; a second one in a row is the
 * App Switcher or Home, so follow the app in front or Springboard. A window
 * that ends without live runner evidence is only read again.
 */
export const followIosHandoff = <E>(input: {
  readonly state: Effect.Effect<IosHandoffState, E>;
  readonly guess: Effect.Effect<string | null, E>;
  readonly guessNow: Effect.Effect<string | null, E>;
  readonly repeated: Ref.Ref<boolean>;
}): Effect.Effect<ForegroundStep<never> | null, E | PlatformRuntimeError> =>
  Effect.gen(function* followHandoff() {
    let last: IosHandoffState = "unverified";
    for (let reading = 0; reading < IOS_HANDOFF_READINGS; reading += 1) {
      last = yield* input.state;
      if (last === "left") {
        yield* Ref.set(input.repeated, false);
        const front = yield* input.guess;
        return front === null ? null : followStep(front);
      }
      yield* Effect.sleep(IOS_HANDOFF_SPACING);
    }
    if (last === "unverified") {
      yield* Ref.set(input.repeated, false);
      return yield* Effect.fail(
        iosCaptureFailure(
          "observation_stale",
          "session-check",
          "app-state-unverified"
        )
      );
    }
    if (yield* Ref.getAndSet(input.repeated, true)) {
      yield* Ref.set(input.repeated, false);
      return followStep((yield* input.guessNow) ?? SPRINGBOARD);
    }
    return yield* Effect.fail(
      iosCaptureFailure("observation_stale", "capture", "foreground-handoff")
    );
  });

type IosCaptureStep = <A>(
  name: "snapshot" | "screenshot" | "app-state" | "read-png" | "session-check",
  effect: Effect.Effect<A, PlatformRuntimeError>
) => Effect.Effect<A, PlatformRuntimeError>;

/** Record only step names and durations, never snapshot nodes, pixels, or SDK messages. */
export const traceIosCapture = <A>(
  capture: (step: IosCaptureStep) => Effect.Effect<A, PlatformRuntimeError>,
  attempt: number
) =>
  Effect.gen(function* traceCapture() {
    const started = yield* Clock.monotonicTimeNanos;
    const steps: { step: string; durationMs: number; outcome: string }[] = [];
    const step = <B>(
      name: string,
      effect: Effect.Effect<B, PlatformRuntimeError>
    ) =>
      Effect.gen(function* traceStep() {
        const began = yield* Clock.monotonicTimeNanos;
        const result = yield* Effect.exit(effect);
        const ended = yield* Clock.monotonicTimeNanos;
        steps.push({
          durationMs: Number(ended - began) / 1e6,
          outcome: Exit.isSuccess(result) ? "ok" : "failed",
          step: name,
        });
        return yield* result;
      });
    return yield* capture(step).pipe(
      Effect.tapError((failure) =>
        Effect.gen(function* logCaptureFailure() {
          const ended = yield* Clock.monotonicTimeNanos;
          yield* Effect.logWarning("iOS capture failed", {
            attempt,
            code: failure.code,
            durationMs: Number(ended - started) / 1e6,
            operation: failure.operation,
            steps,
          });
        })
      )
    );
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
  return iosAgentDeviceFailure(
    cause,
    reason === "invalid-viewport" ||
      reason === "missing-viewport" ||
      // The runner refused the read undispatched while it was still busy,
      // such as with an app coming forward; agent-device marks it retriable.
      reason === "runner_busy" ||
      // The bound app left the front between two reads; the observer follows.
      (isAgentDeviceError(cause) && cause.code === "OBSERVATION_UNAVAILABLE")
      ? "observation_stale"
      : "runtime_failed",
    "capture"
  );
};
/**
 * The observer cannot tell which app is in front, so it never guesses
 * (ADR 0083). Home is always a known screen to carry on from.
 */
export const iosForegroundUnknown = (): PlatformRuntimeError => ({
  ...iosRuntimeError("foreground_app_unknown"),
  message:
    "iOS cannot tell which app is in front of the simulator, so nothing was observed or sent. Press Home (Go Home in the Workspace, or the recover command) and carry on from the Home Screen.",
  operation: "capture",
});
const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  operation: NonNullable<PlatformRuntimeError["operation"]>,
  code: PlatformRuntimeError["code"] = "runtime_failed"
) => tryBackend(run, (cause) => iosAgentDeviceFailure(cause, code, operation));
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
/**
 * An iOS capture may skip its PNG only when the caller needs no image and the
 * window geometry matches the last screenshot-verified geometry verbatim. Any
 * rotation, fold/size change, recovery, or app switch invalidates the cache.
 */
export const canSkipIosScreenshot = (input: {
  readonly includeImage: boolean;
  readonly viewport: IosViewport;
  readonly cachedWindow: IosViewport | null;
  readonly cachedPixels: IosViewport | null;
  readonly cachedScale: { readonly sx: number; readonly sy: number } | null;
}): boolean =>
  !input.includeImage &&
  input.cachedWindow !== null &&
  input.cachedPixels !== null &&
  input.cachedScale !== null &&
  input.viewport.width === input.cachedWindow.width &&
  input.viewport.height === input.cachedWindow.height;

/**
 * Reuses cached alert geometry only when `alert get` reports the same window
 * viewport as the cached screenshot. Any geometry change (such as rotation
 * while an alert is visible) forces a fresh non-activating screenshot.
 */
export const canSkipIosAlertScreenshot = (input: {
  readonly alert: Pick<IosPresentedAlert, "referenceHeight" | "referenceWidth">;
  readonly cachedPixels: IosViewport | null;
  readonly cachedScale: { readonly sx: number; readonly sy: number } | null;
  readonly cachedWindow: IosViewport | null;
  readonly includeImage: boolean;
}): boolean => {
  const referenceViewport =
    input.alert.referenceWidth !== undefined &&
    input.alert.referenceHeight !== undefined
      ? {
          height: input.alert.referenceHeight,
          width: input.alert.referenceWidth,
        }
      : input.cachedWindow;
  return (
    referenceViewport !== null &&
    canSkipIosScreenshot({
      cachedPixels: input.cachedPixels,
      cachedScale: input.cachedScale,
      cachedWindow: input.cachedWindow,
      includeImage: input.includeImage,
      viewport: referenceViewport,
    })
  );
};

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
      orElse: () =>
        Effect.fail(
          iosCaptureFailure("capture_incomplete", "capture", "settle-deadline")
        ),
    })
  );

type IosSessionAppState = Awaited<
  ReturnType<ReturnType<typeof createAgentDeviceClient>["command"]["appState"]>
>;

/**
 * Check the bound app after the screenshot, which can outlive a foreground
 * transition. Any app may be bound: the observer follows the app in front.
 */
export const iosAppStateProblem = (
  state: IosSessionAppState,
  udid: string
): PlatformRuntimeError["code"] | null => {
  if (state.platform !== "ios" || state.device_udid !== udid) {
    return "device_mismatch";
  }
  // appState is passive: the SDK can return session metadata while its live
  // runner is unavailable. Withhold this capture and reacquire within the
  // existing settle bound; metadata alone never proves foreground ownership.
  if (state.source !== "runner" || state.state === undefined) {
    return "observation_stale";
  }
  if (
    state.state === "runningBackground" ||
    state.state === "runningBackgroundSuspended"
  ) {
    // Another app came forward during the capture: observe it next.
    return "observation_stale";
  }
  return state.state === "runningForeground" ? null : "runtime_failed";
};

/** An SDK snapshot rejection, named by reference unless it explains itself. */
const snapshotRejection = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition; `iosSnapshotFailure` parses it.
  cause: unknown
) => failReferenced(iosSnapshotFailure(cause), cause);

/** A simulator host failure, naming the child process failure it replaced. */
const hostFailure = (failure: IosError) =>
  failFromTyped(iosRuntimeError(failure.code), failure);

/** Hint agent-device's iOS runner emits when observeOnly refuses to substitute a presented system alert. */
export const IOS_SYSTEM_ALERT_UNAVAILABLE_HINT =
  "A system alert is presented over the session app. Resolve it with alert, or read it with a regular snapshot.";

/** Hint agent-device's iOS runner emits when an observe-only read finds the app handing off the foreground. */
export const IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT =
  "Another application owns the foreground.";

const readErrorHint = (
  details: AppErrorDetails | undefined
): string | undefined => {
  if (details === undefined) {
    return undefined;
  }
  if (Predicate.isString(details.hint)) {
    return details.hint;
  }
  const { runner } = details;
  if (
    Predicate.isObject(runner) &&
    Predicate.isObject(runner.error) &&
    Predicate.isString(runner.error.hint)
  ) {
    return runner.error.hint;
  }
  return undefined;
};

/**
 * agent-device's observe-only snapshot refuses to substitute a Springboard
 * system alert for the bound app's tree, returning `OBSERVATION_UNAVAILABLE`
 * with a system-alert hint even though the bound app is still in front.
 */
export const isIosSystemAlertObservationUnavailable = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition.
  cause: unknown
): boolean => {
  if (!isAgentDeviceError(cause) || cause.code !== "OBSERVATION_UNAVAILABLE") {
    return false;
  }
  const hint = readErrorHint(cause.details);
  return hint !== undefined && /\bsystem alert\b/iu.test(hint);
};

/**
 * agent-device's observe-only snapshot refuses to capture an app that is
 * handing off the foreground, even while XCUIApplication still reports
 * `runningForeground`: its window no longer fills the screen. Reading such an
 * app's frame or tree through XCTest can hold the runner's main thread for a
 * minute.
 */
export const isIosForegroundHandoffObservationUnavailable = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition.
  cause: unknown
): boolean => {
  if (!isAgentDeviceError(cause) || cause.code !== "OBSERVATION_UNAVAILABLE") {
    return false;
  }
  const hint = readErrorHint(cause.details);
  return hint !== undefined && /\banother application\b/iu.test(hint);
};

/**
 * Confirms whether `OBSERVATION_UNAVAILABLE` on an observe-only snapshot means
 * a system alert is presented over the bound foreground app rather than another
 * app having taken the foreground.
 */
const verifyIosAlertOverBoundApp = (input: {
  readonly appState: (
    options: AppStateCommandOptions
  ) => Promise<IosSessionAppState>;
  readonly boundApp: string | undefined;
  readonly request: {
    readonly platform: "ios";
    readonly udid: string;
    readonly requestId: string;
  };
  readonly systemAlertHint: boolean;
}) =>
  Effect.gen(function* verifyAlertForeground() {
    const state = yield* io(
      (signal) => input.appState({ ...input.request, signal }),
      "session-check"
    );
    if (state.platform !== "ios" || state.device_udid !== input.request.udid) {
      return yield* Effect.fail(iosRuntimeError("device_mismatch"));
    }
    const stateProblem = iosAppStateProblem(state, input.request.udid);
    if (stateProblem === null) {
      return (
        input.boundApp === undefined ||
        state.appBundleId === undefined ||
        state.appBundleId === input.boundApp
      );
    }
    if (
      input.systemAlertHint &&
      (state.source !== "runner" || state.state === undefined)
    ) {
      return yield* Effect.fail(
        iosCaptureFailure(
          "observation_stale",
          "session-check",
          "app-state-unverified"
        )
      );
    }
    return false;
  });

/** Rect reported by agent-device's non-activating `alert get` path (in window points). */
export interface IosAlertRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** One actionable button reported by agent-device's non-activating `alert get` path. */
export interface IosPresentedAlertButton {
  readonly label: string;
  readonly rect?: IosAlertRect | undefined;
}

/** Presented system alert read through agent-device's non-activating `alert get` path. */
export interface IosPresentedAlert {
  readonly buttons?: readonly IosPresentedAlertButton[] | undefined;
  readonly identifiers?: AgentDeviceIdentifiers | undefined;
  readonly items: readonly string[];
  readonly message: string;
  readonly rect?: IosAlertRect | undefined;
  readonly referenceHeight?: number | undefined;
  readonly referenceWidth?: number | undefined;
}

/** One non-activating observation read of the bound iOS app or a system alert over it. */
export type IosSessionRead<A> =
  | { readonly _tag: "snapshot"; readonly snapshot: A }
  | { readonly _tag: "alert"; readonly alert: IosPresentedAlert }
  | { readonly _tag: "handoff" };

/** Exact alert button target bound to the observed prompt message for non-activating dispatch. */
export interface IosAlertTarget {
  readonly buttonIndex: number;
  readonly buttonLabel: string;
  readonly expectedMessage: string;
}

const AlertRectSchema = Schema.Struct({
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  x: Schema.Finite,
  y: Schema.Finite,
});

const AlertButtonSchema = Schema.Struct({
  label: Schema.String,
  rect: Schema.optional(AlertRectSchema),
});

const decodeAlertRect = Schema.decodeUnknownOption(AlertRectSchema);
const decodeAlertButtons = Schema.decodeUnknownOption(
  Schema.Array(AlertButtonSchema)
);
const decodePositiveFinite = Schema.decodeUnknownOption(
  Schema.Finite.check(Schema.isGreaterThan(0))
);

const scaleAlertBounds = (
  rect: IosAlertRect | undefined,
  scale: { readonly sx: number; readonly sy: number } | undefined
): IosAlertRect | undefined =>
  rect === undefined || scale === undefined
    ? undefined
    : {
        height: rect.height * scale.sy,
        width: rect.width * scale.sx,
        x: rect.x * scale.sx,
        y: rect.y * scale.sy,
      };

/**
 * Builds observation nodes and non-activating targeted `alert press` bindings
 * from an `alert get` result. Every reported button is actionable by its own
 * exact label and index, bound to the observed alert message, and carries its
 * scaled screen bounds when reported by the runner.
 */
export const iosAlertNodes = (
  alert: IosPresentedAlert,
  app: string,
  generation: number,
  scale?: { readonly sx: number; readonly sy: number }
) => {
  const actions = new Map<string, IosAlertTarget>();
  const alertBounds = scaleAlertBounds(alert.rect, scale);
  const rootBase: IosObservation["nodes"][number] = {
    covered: false,
    editable: false,
    hittable: false,
    name: alert.message,
    packageName: app,
    password: false,
    role: "alert",
    target: `@alert-0~a${generation}`,
  };
  const nodes: IosObservation["nodes"][number][] = [
    alertBounds === undefined ? rootBase : { ...rootBase, bounds: alertBounds },
  ];
  const buttons: readonly IosPresentedAlertButton[] =
    alert.buttons !== undefined && alert.buttons.length > 0
      ? alert.buttons
      : alert.items.map((label) => ({ label }));
  for (const [index, button] of buttons.entries()) {
    const target = `@alert-${index + 1}~a${generation}`;
    actions.set(target, {
      buttonIndex: index,
      buttonLabel: button.label,
      expectedMessage: alert.message,
    });
    const bounds = scaleAlertBounds(button.rect, scale);
    const buttonBase: IosObservation["nodes"][number] = {
      covered: false,
      editable: false,
      hittable: true,
      name: button.label,
      packageName: app,
      password: false,
      role: "button",
      target,
    };
    nodes.push(bounds === undefined ? buttonBase : { ...buttonBase, bounds });
  }
  return { actions, nodes };
};

const isIosAlertChangedError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition.
  cause: unknown
): boolean => {
  if (!isAgentDeviceError(cause)) {
    return false;
  }
  const runnerCode = cause.details?.runnerErrorCode;
  const reason = cause.details?.reason;
  return (
    cause.code === "ALERT_MISMATCH" ||
    cause.code === "ALERT_NOT_FOUND" ||
    cause.code === "ALERT_BUTTON_NOT_FOUND" ||
    cause.code === "ALERT_UNRESOLVED" ||
    runnerCode === "ALERT_MISMATCH" ||
    runnerCode === "ALERT_NOT_FOUND" ||
    runnerCode === "ALERT_BUTTON_NOT_FOUND" ||
    runnerCode === "ALERT_UNRESOLVED" ||
    reason === "alert_mismatch" ||
    reason === "alert-not-found"
  );
};

/**
 * Classifies an `alert press` refusal. When the runner proved nothing was
 * dispatched because the alert disappeared, changed message, or changed
 * buttons, return a retriable `target_changed` refusal instead of pausing.
 */
export const iosAlertActivateFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition.
  cause: unknown
): PlatformRuntimeError =>
  isIosAlertChangedError(cause)
    ? {
        _tag: "PlatformRuntimeError",
        code: "target_changed",
        message:
          "The observed iOS system alert changed or disappeared. Refresh and choose the button again; no input was forwarded.",
        operation: "activate",
      }
    : iosAgentDeviceFailure(cause, "runtime_failed", "activate");

const isIosAlertAbsentError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected SDK promise is unknown by definition.
  cause: unknown
): boolean => {
  if (!isAgentDeviceError(cause)) {
    return false;
  }
  const runnerCode = cause.details?.runnerErrorCode;
  const reason = cause.details?.reason;
  return (
    cause.code === "ALERT_NOT_FOUND" ||
    cause.code === "ALERT_UNRESOLVED" ||
    runnerCode === "ALERT_NOT_FOUND" ||
    runnerCode === "ALERT_UNRESOLVED" ||
    reason === "alert-not-found"
  );
};

const readAlertIdentifiers = (
  raw: CommandRequestResult
): AgentDeviceIdentifiers | undefined => {
  const value = raw.identifiers;
  if (!Predicate.isObject(value)) {
    return undefined;
  }
  const session = Predicate.isString(value.session) ? value.session : undefined;
  const udid = Predicate.isString(value.udid) ? value.udid : undefined;
  if (session !== undefined && udid !== undefined) {
    return { session, udid };
  }
  if (session !== undefined) {
    return { session };
  }
  if (udid !== undefined) {
    return { udid };
  }
  return undefined;
};

const parseIosPresentedAlert = (
  raw: CommandRequestResult
): IosPresentedAlert | null => {
  const rawButtons = Option.getOrElse(decodeAlertButtons(raw.buttons), () => [])
    .map((entry): IosPresentedAlertButton | null => {
      const label = entry.label.trim();
      if (label === "") {
        return null;
      }
      return entry.rect === undefined ? { label } : { label, rect: entry.rect };
    })
    .filter((entry): entry is IosPresentedAlertButton => entry !== null);
  let items: string[] = [];
  if (rawButtons.length > 0) {
    items = rawButtons.map((button) => button.label);
  } else if (Array.isArray(raw.items)) {
    items = raw.items.flatMap((entry) => {
      if (!Predicate.isString(entry)) {
        return [];
      }
      const trimmed = entry.trim();
      return trimmed === "" ? [] : [trimmed];
    });
  }
  if (items.length === 0) {
    return null;
  }
  const message =
    Predicate.isString(raw.message) && raw.message.trim() !== ""
      ? raw.message.trim()
      : "System Alert";
  const rect = Option.getOrUndefined(decodeAlertRect(raw.rect));
  const referenceWidth = Option.getOrUndefined(
    decodePositiveFinite(raw.referenceWidth)
  );
  const referenceHeight = Option.getOrUndefined(
    decodePositiveFinite(raw.referenceHeight)
  );
  const parsed: IosPresentedAlert = {
    buttons: rawButtons.length > 0 ? rawButtons : undefined,
    identifiers: readAlertIdentifiers(raw),
    items,
    message,
    rect,
    referenceHeight:
      referenceWidth !== undefined && referenceHeight !== undefined
        ? referenceHeight
        : undefined,
    referenceWidth:
      referenceWidth !== undefined && referenceHeight !== undefined
        ? referenceWidth
        : undefined,
  };
  return parsed;
};

/** Session-bound SDK access shared by Teaching, Dry Runs, and Runs. */
export const makeIosSessionAccess = <A, B>(input: {
  readonly snapshot: (options: CaptureSnapshotOptions) => Promise<A>;
  readonly open: (options: AppOpenOptions) => Promise<B>;
  readonly appState?: (
    options: AppStateCommandOptions
  ) => Promise<IosSessionAppState>;
  readonly alert?: (
    options: AlertCommandOptions
  ) => Promise<CommandRequestResult>;
  readonly options: () => {
    readonly platform: "ios";
    readonly udid: string;
    readonly requestId: string;
  };
}) => ({
  /**
   * Binds the session to an app without relaunching it. Binding activates
   * the app, so callers bind only to the app already in front.
   */
  bind: (app: string) =>
    io(
      (signal) =>
        input.open({
          ...input.options(),
          app,
          noRecord: true,
          relaunch: false,
          signal,
        }),
      "open"
    ).pipe(Effect.asVoid),
  /**
   * The bound app's tree, a presented system alert over it, or none when
   * another app is in front. Every read path here is non-activating: snapshots
   * always pass `observeOnly: true`, and system alerts are read through
   * `alert get` (`launchPolicy: .presentedSurface`), never a regular snapshot
   * that could call `target.activate()` if the bound app backgrounds mid-read.
   */
  snapshot: (
    boundApp?: string
  ): Effect.Effect<Option.Option<IosSessionRead<A>>, PlatformRuntimeError> =>
    Effect.tryPromise({
      catch: (cause) => cause,
      try: (signal) =>
        input.snapshot({
          ...input.options(),
          interactiveOnly: false,
          noRecord: true,
          observeOnly: true,
          signal,
        }),
    }).pipe(
      Effect.map((snapshot) =>
        Option.some<IosSessionRead<A>>({ _tag: "snapshot", snapshot })
      ),
      // Another app in front is not a failure: the caller follows it.
      // Anything else is the SDK's own failure: name it by reference.
      Effect.catchIf(
        (cause) =>
          isAgentDeviceError(cause) && cause.code === "OBSERVATION_UNAVAILABLE",
        (cause) =>
          Effect.gen(function* handleObservationUnavailable() {
            if (isIosForegroundHandoffObservationUnavailable(cause)) {
              return Option.some<IosSessionRead<A>>({ _tag: "handoff" });
            }
            const systemAlertHint =
              isIosSystemAlertObservationUnavailable(cause);
            const readAppState = input.appState;
            const canReadAlert =
              readAppState === undefined
                ? systemAlertHint
                : yield* verifyIosAlertOverBoundApp({
                    appState: readAppState,
                    boundApp,
                    request: input.options(),
                    systemAlertHint,
                  });
            const readAlert = input.alert;
            if (!canReadAlert || readAlert === undefined) {
              return Option.none<IosSessionRead<A>>();
            }
            const rawAlert = yield* Effect.tryPromise({
              catch: (alertCause) => alertCause,
              try: (signal) =>
                readAlert({
                  ...input.options(),
                  action: "get",
                  signal,
                }),
            }).pipe(
              Effect.catchIf(
                isIosAlertAbsentError,
                () =>
                  Effect.fail(
                    iosCaptureFailure(
                      "observation_stale",
                      "capture",
                      "alert-dismissed"
                    )
                  ),
                snapshotRejection
              )
            );
            const alert = parseIosPresentedAlert(rawAlert);
            if (alert === null) {
              return yield* Effect.fail(
                iosCaptureFailure(
                  "observation_stale",
                  "capture",
                  "alert-dismissed"
                )
              );
            }
            return Option.some<IosSessionRead<A>>({ _tag: "alert", alert });
          }),
        snapshotRejection
      )
    ),
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
        .pipe(Effect.catchTag("IosError", hostFailure));
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
        alert: client.command.alert.bind(client.command),
        appState: client.command.appState.bind(client.command),
        open: client.apps.open.bind(client.apps),
        options,
        snapshot: client.capture.snapshot.bind(client.capture),
      });
      const window = yield* Ref.make<IosViewport | null>(null);
      const screenPixels = yield* Ref.make<IosViewport | null>(null);
      const pixelScale = yield* Ref.make<{
        readonly sx: number;
        readonly sy: number;
      } | null>(null);
      // Presented system-alert buttons, by synthetic target, dispatched via non-activating targeted `alert press`.
      const alertActions = yield* Ref.make<ReadonlyMap<string, IosAlertTarget>>(
        new Map()
      );
      let alertGeneration = 0;
      const clearGeometryCache = Ref.set(window, null).pipe(
        Effect.andThen(Ref.set(screenPixels, null)),
        Effect.andThen(Ref.set(pixelScale, null)),
        Effect.andThen(Ref.set(alertActions, new Map()))
      );
      // Preparation opened the session on the Target App, now in front.
      const bound = yield* Ref.make(input.targetApp);
      const bind = (app: string) =>
        access
          .bind(app)
          .pipe(
            Effect.andThen(Ref.set(bound, app)),
            Effect.andThen(clearGeometryCache)
          );
      const guess = makeIosForegroundGuess(iosHostProcesses, udid);
      // Set while no app could be named in front; recovery then goes Home.
      const lost = yield* Ref.make(false);
      // Set while the last read of the bound app was a handoff still in front.
      const handedOff = yield* Ref.make(false);
      const fillPublic = client.interactions.fill.bind(client.interactions);
      // Tap points, by target, for controls UIKit draws away from their frame's center.
      const activationPoints = yield* Ref.make<
        ReadonlyMap<string, { readonly x: number; readonly y: number }>
      >(new Map());
      const captureAlertObservation = (
        step: IosCaptureStep,
        app: string,
        includeImage: boolean,
        alert: IosPresentedAlert
      ) =>
        Effect.gen(function* observeAlert() {
          yield* identities(alert.identifiers, udid, session);
          if (alert.identifiers === undefined) {
            yield* step("session-check", validate());
          }
          const id = randomUUID();
          const cachedWindow = yield* Ref.get(window);
          const cachedPixels = yield* Ref.get(screenPixels);
          const cachedScale = yield* Ref.get(pixelScale);
          const referenceViewport =
            alert.referenceWidth !== undefined &&
            alert.referenceHeight !== undefined
              ? { height: alert.referenceHeight, width: alert.referenceWidth }
              : cachedWindow;
          const needScreenshot = !canSkipIosAlertScreenshot({
            alert,
            cachedPixels,
            cachedScale,
            cachedWindow,
            includeImage,
          });
          let width: number;
          let height: number;
          let scale: { readonly sx: number; readonly sy: number } | undefined;
          let encodedImage = "";
          if (needScreenshot) {
            const filename = path.join(
              prepared.directory,
              `observation-${id}.png`
            );
            const screenshot = yield* step(
              "screenshot",
              io(
                (signal) =>
                  client.capture.screenshot({
                    ...options(),
                    path: filename,
                    signal,
                  }),
                "screenshot"
              )
            );
            yield* identities(screenshot.identifiers, udid, session);
            const bytes = yield* step(
              "read-png",
              io(() => readFile(filename), "host-io")
            );
            if (
              bytes.length < 24 ||
              !bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ) {
              return yield* Effect.fail(
                iosCaptureFailure(
                  "capture_incomplete",
                  "screenshot",
                  "png-header"
                )
              );
            }
            width = bytes.readUInt32BE(16);
            height = bytes.readUInt32BE(20);
            const appState = yield* step(
              "app-state",
              io(
                (signal) => client.command.appState({ ...options(), signal }),
                "session-check"
              )
            );
            const stateProblem = iosAppStateProblem(appState, udid);
            if (stateProblem !== null) {
              return yield* Effect.fail(
                stateProblem === "observation_stale"
                  ? iosCaptureFailure(
                      stateProblem,
                      "session-check",
                      "app-state-unverified"
                    )
                  : iosRuntimeError(stateProblem)
              );
            }
            if (
              referenceViewport !== null &&
              Math.sign(width - height) !==
                Math.sign(referenceViewport.width - referenceViewport.height)
            ) {
              return yield* Effect.fail(iosRuntimeError("observation_stale"));
            }
            if (referenceViewport !== null) {
              scale = {
                sx: width / referenceViewport.width,
                sy: height / referenceViewport.height,
              };
              yield* Ref.set(window, referenceViewport);
              yield* Ref.set(screenPixels, { height, width });
              yield* Ref.set(pixelScale, scale);
            } else if (cachedScale !== null) {
              scale = cachedScale;
            }
            encodedImage = bytes.toString("base64");
          } else if (cachedPixels !== null && cachedScale !== null) {
            const appState = yield* step(
              "app-state",
              io(
                (signal) => client.command.appState({ ...options(), signal }),
                "session-check"
              )
            );
            const stateProblem = iosAppStateProblem(appState, udid);
            if (stateProblem !== null) {
              return yield* Effect.fail(
                stateProblem === "observation_stale"
                  ? iosCaptureFailure(
                      stateProblem,
                      "session-check",
                      "app-state-unverified"
                    )
                  : iosRuntimeError(stateProblem)
              );
            }
            ({ width, height } = cachedPixels);
            scale = cachedScale;
          } else {
            return yield* Effect.fail(
              iosCaptureFailure("capture_incomplete", "capture", "png-header")
            );
          }
          alertGeneration += 1;
          const built = iosAlertNodes(alert, app, alertGeneration, scale);
          yield* Ref.set(activationPoints, new Map());
          yield* Ref.set(alertActions, built.actions);
          const observation: IosObservation = {
            appId: app,
            backendSessionId: session,
            device: prepared.device,
            frame: { height, width },
            generation: alertGeneration,
            id,
            nodes: built.nodes,
            platform: "ios",
            screenshot: {
              capturedAt: new Date().toISOString(),
              encoding: "base64",
              format: "png",
              image: encodedImage,
            },
          };
          yield* Ref.set(lost, false);
          return observedStep(observation);
        });
      /**
       * One observation of the bound app, or the app to follow when another
       * one is in front (ADR 0083). The runtime validates the session on its
       * own cadence; capture checks snapshot/screenshot identity and foreground
       * app state directly, falling back to `validate()` if identifiers are absent.
       */
      const attemptOnce = (
        step: IosCaptureStep,
        app: string,
        includeImage: boolean
      ) =>
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* captureIos() {
          const read = yield* step("snapshot", access.snapshot(app));
          if (Option.isNone(read)) {
            // The bound app went to the background on its own, such as a
            // link that opened Safari. Follow only a clear guess among the
            // other apps.
            const front = app === SPRINGBOARD ? null : yield* guess(app);
            if (front === null) {
              yield* Ref.set(lost, true);
              return yield* Effect.fail(iosForegroundUnknown());
            }
            return followStep(front);
          }
          if (read.value._tag === "handoff") {
            const front = yield* followIosHandoff({
              guess: guess(app),
              guessNow: guess.now(app),
              repeated: handedOff,
              state: io(
                (signal) => client.command.appState({ ...options(), signal }),
                "session-check"
              ).pipe(Effect.map(iosHandoffState)),
            });
            if (front === null) {
              yield* Ref.set(lost, true);
              return yield* Effect.fail(iosForegroundUnknown());
            }
            return front;
          }
          yield* Ref.set(handedOff, false);
          if (read.value._tag === "alert") {
            return yield* captureAlertObservation(
              step,
              app,
              includeImage,
              read.value.alert
            );
          }
          const { snapshot } = read.value;
          yield* identities(snapshot.identifiers, udid, session);
          if (snapshot.identifiers === undefined) {
            yield* step("session-check", validate());
          }
          if (app === SPRINGBOARD) {
            const front = springboardForeground(snapshot);
            if (front !== null) {
              return followStep(front);
            }
          }
          const problem = iosSnapshotProblem(snapshot);
          if (
            problem !== null ||
            !snapshot.viewport ||
            snapshot.refsGeneration === undefined
          ) {
            return yield* Effect.fail(
              iosCaptureFailure(
                problem ?? "capture_incomplete",
                "capture",
                "snapshot-metadata"
              )
            );
          }
          const cachedWindow = yield* Ref.get(window);
          const viewport = iosWindowViewport(
            { nodes: snapshot.nodes, viewport: snapshot.viewport },
            cachedWindow
          );
          const id = randomUUID();
          const cachedPixels = yield* Ref.get(screenPixels);
          const cachedScale = yield* Ref.get(pixelScale);
          const needScreenshot = !canSkipIosScreenshot({
            cachedPixels,
            cachedScale,
            cachedWindow,
            includeImage,
            viewport,
          });
          let width: number;
          let height: number;
          let sx: number;
          let sy: number;
          let encodedImage = "";
          if (needScreenshot) {
            const filename = path.join(
              prepared.directory,
              `observation-${id}.png`
            );
            const screenshot = yield* step(
              "screenshot",
              io(
                (signal) =>
                  client.capture.screenshot({
                    ...options(),
                    path: filename,
                    signal,
                  }),
                "screenshot"
              )
            );
            yield* identities(screenshot.identifiers, udid, session);
            const bytes = yield* step(
              "read-png",
              io(() => readFile(filename), "host-io")
            );
            if (
              bytes.length < 24 ||
              !bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ) {
              return yield* Effect.fail(
                iosCaptureFailure(
                  "capture_incomplete",
                  "screenshot",
                  "png-header"
                )
              );
            }
            width = bytes.readUInt32BE(16);
            height = bytes.readUInt32BE(20);
            if (
              app !== SPRINGBOARD &&
              !fillsScreen(snapshot.nodes[0], { height, width })
            ) {
              // The bound app is shrinking during a handoff, toward Home, or
              // in the App Switcher: follow an unambiguous foreground app, or
              // Springboard when no other app is in front.
              const front = yield* guess.now(app);
              return followStep(front ?? SPRINGBOARD);
            }
            const appState = yield* step(
              "app-state",
              io(
                (signal) => client.command.appState({ ...options(), signal }),
                "session-check"
              )
            );
            const stateProblem = iosAppStateProblem(appState, udid);
            if (stateProblem !== null) {
              return yield* Effect.fail(
                stateProblem === "observation_stale"
                  ? iosCaptureFailure(
                      stateProblem,
                      "session-check",
                      "app-state-unverified"
                    )
                  : iosRuntimeError(stateProblem)
              );
            }
            if (
              Math.sign(width - height) !==
              Math.sign(viewport.width - viewport.height)
            ) {
              return yield* Effect.fail(iosRuntimeError("observation_stale"));
            }
            sx = width / viewport.width;
            sy = height / viewport.height;
            yield* Ref.set(screenPixels, { height, width });
            yield* Ref.set(pixelScale, { sx, sy });
            encodedImage = bytes.toString("base64");
          } else if (cachedPixels !== null && cachedScale !== null) {
            if (
              app !== SPRINGBOARD &&
              !fillsScreen(snapshot.nodes[0], cachedPixels)
            ) {
              const front = yield* guess.now(app);
              return followStep(front ?? SPRINGBOARD);
            }
            const appState = yield* step(
              "app-state",
              io(
                (signal) => client.command.appState({ ...options(), signal }),
                "session-check"
              )
            );
            const stateProblem = iosAppStateProblem(appState, udid);
            if (stateProblem !== null) {
              return yield* Effect.fail(
                stateProblem === "observation_stale"
                  ? iosCaptureFailure(
                      stateProblem,
                      "session-check",
                      "app-state-unverified"
                    )
                  : iosRuntimeError(stateProblem)
              );
            }
            ({ sx, sy } = cachedScale);
            width = Math.round(viewport.width * sx);
            height = Math.round(viewport.height * sy);
          } else {
            return yield* Effect.fail(
              iosCaptureFailure("capture_incomplete", "capture", "png-header")
            );
          }
          yield* Ref.set(window, viewport);
          const target = (ref: string | undefined) =>
            ref === undefined
              ? ""
              : `@${ref.replace(/^@/u, "")}~s${snapshot.refsGeneration}`;
          yield* Ref.set(alertActions, new Map());
          yield* Ref.set(
            activationPoints,
            new Map(
              snapshot.nodes.flatMap((node) => {
                const ref = target(node.ref);
                const point =
                  ref === "" ? null : iosActivationPoint(snapshot.nodes, node);
                return point === null ? [] : [[ref, point]];
              })
            )
          );
          const observation: IosObservation = {
            // An observe-only snapshot may not name its app; the bound app is
            // the one this attempt proved in front.
            appId: snapshot.appBundleId ?? app,
            backendSessionId: session,
            device: prepared.device,
            frame: { height, width },
            generation: snapshot.refsGeneration,
            id,
            nodes: snapshot.nodes.map((node, index) => {
              const ref = target(node.ref);
              const interaction = iosNodeInteraction(node);
              const observed: IosObservation["nodes"][number] = {
                ...interaction,
                editable: ref !== "" && interaction.editable,
                hittable: ref !== "" && interaction.hittable,
                name: iosNodeName(snapshot.nodes, index),
                packageName: node.bundleId ?? snapshot.appBundleId ?? null,
                target: ref,
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
              image: encodedImage,
            },
          };
          yield* Ref.set(lost, false);
          return observedStep(observation);
        });
      const captureOnce = (step: IosCaptureStep, includeImage: boolean) =>
        followForeground({
          attempt: (app) => attemptOnce(step, app, includeImage),
          bind,
          bound,
          stale: iosCaptureFailure(
            "observation_stale",
            "capture",
            "app-state-unverified"
          ),
        });
      let captureAttempt = 0;
      const capture = (captureOptions?: NativeCaptureOptions) =>
        settleIosCapture(
          Effect.suspend(() => {
            captureAttempt += 1;
            return traceIosCapture(
              (step) => captureOnce(step, captureOptions?.image !== false),
              captureAttempt
            );
          })
        );
      /** Commands that act through the bound app, which is the one in front. */
      const command = <A>(
        operation: NonNullable<PlatformRuntimeError["operation"]>,
        run: (signal: AbortSignal) => Promise<A>
      ) => io(run, operation).pipe(Effect.asVoid);
      return yield* adaptNativeAppRuntime({
        backend: {
          activate: (target) =>
            Effect.gen(function* activateIos() {
              const alertTarget = (yield* Ref.get(alertActions)).get(target);
              if (alertTarget !== undefined) {
                yield* tryBackend(
                  (signal) =>
                    client.command.alert({
                      ...options(),
                      action: "press",
                      buttonIndex: alertTarget.buttonIndex,
                      buttonLabel: alertTarget.buttonLabel,
                      expectedMessage: alertTarget.expectedMessage,
                      signal,
                    }),
                  iosAlertActivateFailure
                );
                return;
              }
              const point = (yield* Ref.get(activationPoints)).get(target);
              yield* io(
                (signal) =>
                  client.interactions.click(
                    point === undefined
                      ? { ...options(), ref: target, signal }
                      : { ...options(), ...point, signal }
                  ),
                "activate"
              );
            }),
          capture,
          close: () => Scope.close(resources, Exit.void),
          fill: (target, text) =>
            performNativeAppFill(
              (signal) =>
                fillPublic({ ...options(), ref: target, signal, text }),
              iosRuntimeError
            ),
          // Recovery never reopens the Target App. When no app could be
          // named in front, it goes Home, which Springboard always observes.
          recover: () =>
            clearGeometryCache.pipe(
              Effect.andThen(validate()),
              Effect.andThen(Ref.get(lost)),
              Effect.flatMap((home) =>
                home
                  ? command("home", (signal) =>
                      client.command.home({ ...options(), signal })
                    ).pipe(
                      Effect.andThen(bind(SPRINGBOARD)),
                      Effect.andThen(Ref.set(lost, false))
                    )
                  : Effect.void
              )
            ),
          rotate: (orientation) =>
            clearGeometryCache.pipe(
              Effect.andThen(
                command("rotate", (signal) =>
                  client.command.orientation({
                    ...options(),
                    orientation:
                      orientation === "landscape"
                        ? "landscape-left"
                        : "portrait",
                    signal,
                  })
                )
              )
            ),
          // Whole screen, touches hidden (ADR 0079).
          screenRecorder: makeAgentDeviceScreenRecorder({
            record: ({ action, path: file, signal }) =>
              client.recording.record(
                file === undefined
                  ? {
                      ...options(),
                      action,
                      hideTouches: true,
                      recordingScope: "device",
                      signal,
                    }
                  : {
                      ...options(),
                      action,
                      hideTouches: true,
                      path: file,
                      recordingScope: "device",
                      signal,
                    }
              ),
          }),
          sessionId: session,
          // Home and the App Switcher leave Springboard in front, so the
          // session binds to it at once (ADR 0083). iOS has no Back.
          systemKey: (key) =>
            key === "back"
              ? Effect.fail(iosRuntimeError("capability_missing"))
              : command(key, async (signal) => {
                  await (key === "home"
                    ? client.command.home({ ...options(), signal })
                    : client.command.appSwitcher({ ...options(), signal }));
                }).pipe(Effect.andThen(bind(SPRINGBOARD))),
          validate,
        },
        capabilities: iosCapabilities,
        error: iosRuntimeError,
        foreground: (observation) => observation.appId ?? undefined,
        policy: nativeAppActionPolicy(iosRuntimeError, iosSystemKeys),
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
          installedBuild: request.installedBuild ?? null,
          kind: "app-installation" as const,
          runId,
          targetApp: request.targetApp,
        },
      ]),
  ...clearAppDataDecision(request, runId),
];

/** The Target App build already on the simulator, or null when absent. */
const readInstalledIosBuild = (request: IosRunInput) =>
  makeIosDiscovery()
    .apps(request.device)
    .pipe(
      Effect.map(
        (apps) =>
          apps.find((app) => app.bundleId === request.environment.bundleId)
            ?.build ?? null
      ),
      Effect.catchTag("IosError", hostFailure)
    );

const defaultIosRunDriver: Required<IosRunDriver> = {
  installedBuild: readInstalledIosBuild,
  preflight: (request) =>
    makeIosDiscovery()
      .requireRunning(request.device)
      .pipe(
        Effect.asVoid,
        Effect.catchTag("IosError", hostFailure),
        Effect.andThen(verifyIosFramebufferRelease()),
        Effect.asVoid
      ),
  restart: (request) =>
    restartIosTargetApp(iosSimctlHost, {
      bundleId: request.targetApp,
      environment: request.environment,
      setup: request.setup,
      udid: request.device.udid,
    }).pipe(Effect.catchTag("IosError", hostFailure)),
  start: startIosRuntime,
};

export const createIosRun = (
  request: IosRunInput,
  deps: Partial<IosRunDriver> = {}
): Effect.Effect<IosRun, PlatformRuntimeError> =>
  Effect.suspend(() => {
    const driver = {
      installedBuild: deps.installedBuild ?? defaultIosRunDriver.installedBuild,
      preflight: deps.preflight ?? defaultIosRunDriver.preflight,
      restart: deps.restart ?? defaultIosRunDriver.restart,
      start: deps.start ?? defaultIosRunDriver.start,
    };
    // Read once per run, after the first preflight verified the simulator, so
    // the installation decision can say which build it replaces.
    let { installedBuild } = request;
    return createNativeAppRun(request, {
      authorize: (input) => input,
      decisions: (input, runId) =>
        iosRunDecisions(
          installedBuild === undefined ? input : { ...input, installedBuild },
          runId
        ),
      differences: (input) =>
        input.taught.platform === "ios"
          ? compareIosEnvironments(input.taught.environment, input.environment)
          : [],
      error: iosRuntimeError,
      preflight: (input, phase) =>
        driver.preflight(input, phase).pipe(
          Effect.andThen(
            installedBuild !== undefined ||
              phase !== undefined ||
              input.appPath === undefined
              ? Effect.void
              : driver.installedBuild(input).pipe(
                  Effect.flatMap((build) =>
                    Effect.sync(() => {
                      installedBuild = build;
                    })
                  )
                )
          )
        ),
      restart: driver.restart,
      start: driver.start,
      startingConditions: (input, observation) =>
        input.setup.conditions.every((condition) =>
          observation.nodes.some(
            (node) =>
              !node.covered &&
              !node.password &&
              node.role === condition.role &&
              node.name === condition.name
          )
        ),
      validate: (input) => {
        if (!supportsIosPermissions(input.environment)) {
          return Effect.fail(iosRuntimeError("permission_service_unsupported"));
        }
        return input.taught.platform === "ios" &&
          input.requiredCapabilities.every((capability) =>
            iosCapabilities.some((supported) => supported === capability)
          ) &&
          input.environment.bundleId === input.targetApp
          ? Effect.void
          : Effect.fail(iosRuntimeError("capability_missing"));
      },
    });
  });
