import { Cause, Effect, Result } from "effect";

import { recordFailure } from "./failure-reference.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const messages = {
  api_unsupported:
    "This Android API level is outside the Support Matrix. Select a device running API 30 through 36; API levels below 30 are unsupported.",
  app_installation_refused:
    "The device refused to install the Target App build. Nothing was uninstalled.",
  capability_missing:
    "The Android runtime does not support a required capability. Coordinate input and Teaching capture are unavailable.",
  capture_incomplete:
    "Android capture is incomplete or obscured. Execution is paused.",
  cleanup_failed:
    "Android cleanup is incomplete. Retained owned state requires inspection before recovery.",
  device_disconnected:
    "The selected Android device is disconnected. Execution is paused.",
  device_in_use:
    "Another agent-device session holds this Android device, so another automation tool may be using it. Close that session, then retry preparation. No session was adopted.",
  device_lock_held:
    "Another Contingency process is using this Android device. Close its Android session or let that process exit, then start a new Android session. No session was adopted.",
  device_mismatch:
    "The selected Android device identity changed. Execution is paused.",
  device_selection_required:
    "Explicitly select a local Android device by serial and identity.",
  device_unsupported:
    "Select an iPhone simulator. Physical iPhones and iPads are unsupported.",
  discovery_failed: "Could not read the iOS Simulator inventory.",
  environment_changed:
    "The selected Android app build or permission state changed. Start a new Run and review its environment.",
  execution_canceled:
    "Android execution was canceled. Take a fresh observation after explicit recovery; do not replay input.",
  helper_incompatible:
    "The Android helper does not match the pinned release or required API.",
  helper_newer_installed:
    "This device has a newer agent-device helper than the release Contingency pins, and Android cannot replace it with an older one. Uninstall com.callstack.agentdevice.snapshothelper from this device, then start a new Android session. No input was sent.",
  helper_owned:
    "The Android helper app is already running on this device, so another automation tool may be using it. Stop that tool, then start a new Android session. No existing session was adopted.",
  host_unsupported: "iOS Simulator requires a local macOS host.",
  installation_denied:
    "Authorize installation or replacement of this exact helper release on the selected device.",
  installation_failed:
    "The authorized Android helper installation did not finish successfully. No input was sent.",
  observation_stale:
    "Take a fresh Android observation before acting. Observations are consumed once.",
  os_unsupported: "Select an iPhone simulator running iOS 26 through 27.",
  permission_decisions_unsupported:
    "Android permission decisions need API 31 or later, which can keep a denied choice from prompting again. Remove the permission declarations or select an API 31 through 36 device.",
  permission_stale: "This decision is not pending for this Run.",
  physical_device_unsupported:
    "Physical Android devices are unsupported. Select an emulator.",
  preparation_failed:
    "The declared Android setup is unsupported or failed. Input is blocked.",
  preparation_required:
    "Complete Android preparation and all Run decisions before input.",
  runtime_closed: "The Android runtime is closed.",
  runtime_failed:
    "The Android backend failed. Execution is paused; dispatched input may have an uncertain outcome.",
  runtime_missing: "Install the selected iOS Simulator runtime in Xcode.",
  runtime_paused:
    "Android execution is paused. Explicitly recover the same selected device before continuing.",
  secure_window:
    "Secure window, not visible. Android input is paused and the outcome is inconclusive.",
  starting_condition_failed:
    "The fresh Android observation did not satisfy the declared starting conditions.",
  target_changed:
    "The observed Android field or window changed. No input was sent; take a fresh observation.",
  target_unsupported:
    "The Android target is absent, covered, or unsupported for this action.",
  xcode_missing: "Select a full Xcode installation with xcode-select.",
} as const;

export const platformRuntimeError = (
  code: keyof typeof messages
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: messages[code],
});

/** The device's own reason for refusing a Target App install. Never uninstalls. */
export const appInstallationRefused = (
  reason: string
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "app_installation_refused",
  message: `The device refused to install the Target App build: ${reason}. Nothing was uninstalled, so the installed app and its data are unchanged.`,
});

/** Failures whose code is the whole story: the device is busy or mid-transition. */
const SELF_EXPLAINING = new Set<PlatformRuntimeError["code"]>([
  "capture_incomplete",
  "device_in_use",
  "observation_stale",
]);

/**
 * Records the backend failure a runtime error replaces, so the error can name
 * it by Failure Reference. The backend's own message never leaves: it is
 * logged by its shape and kept whole only in memory (ADR 0089). A failure
 * whose code or backend reason explains it gets no reference.
 */
export const referenceRuntimeFailure = (
  error: PlatformRuntimeError,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected backend promise is unknown by definition; it is only logged by shape and kept, never read.
  cause: unknown
): Effect.Effect<PlatformRuntimeError> =>
  error.backendReason !== undefined || SELF_EXPLAINING.has(error.code)
    ? Effect.succeed(error)
    : recordFailure(Cause.fail({ ...error, cause }), error.code).pipe(
        Effect.annotateLogs({ operation: error.operation }),
        Effect.map((failureReference) => ({ ...error, failureReference }))
      );

/**
 * Runs one backend call. Its failure becomes the runtime error `toError`
 * names, which carries a Failure Reference when its code does not explain it.
 */
export const tryBackend = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `toError` is the parser of the backend's unknown rejection.
  toError: (cause: unknown) => PlatformRuntimeError
): Effect.Effect<A, PlatformRuntimeError> =>
  Effect.gen(function* callBackend() {
    const result = yield* Effect.result(
      Effect.tryPromise({ catch: (cause) => cause, try: run })
    );
    if (Result.isSuccess(result)) {
      return result.success;
    }
    return yield* Effect.fail(
      yield* referenceRuntimeFailure(toError(result.failure), result.failure)
    );
  });
