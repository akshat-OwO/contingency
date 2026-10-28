import type { PlatformRuntimeError } from "./platform-runtime.ts";

const messages = {
  api_unsupported:
    "This Android API level is outside the Support Matrix. Select a device running API 30 through 36; API levels below 30 are unsupported.",
  capability_missing:
    "The Android runtime does not support a required capability. Coordinate input and Teaching capture are unavailable.",
  capture_incomplete:
    "Android capture is incomplete or obscured. Execution is paused.",
  cleanup_failed:
    "Android cleanup is incomplete. Retained owned state requires inspection before recovery.",
  device_disconnected:
    "The selected Android device is disconnected. Execution is paused.",
  device_mismatch:
    "The selected Android device identity changed. Execution is paused.",
  device_selection_required:
    "Explicitly select a local Android device by serial and identity.",
  environment_changed:
    "The selected Android app build or permission state changed. Start a new Run and review its environment.",
  execution_canceled:
    "Android execution was canceled. Take a fresh observation after explicit recovery; do not replay input.",
  helper_incompatible:
    "The Android helper does not match the pinned release or required API.",
  helper_owned:
    "An Android helper or device session is already owned. No existing session was adopted.",
  installation_denied:
    "Authorize installation or replacement of this exact helper release on the selected device.",
  installation_failed:
    "The authorized Android helper installation did not finish successfully. No input was sent.",
  observation_stale:
    "Take a fresh Android observation before acting. Observations are consumed once.",
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
} as const;

export const platformRuntimeError = (
  code: keyof typeof messages
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: messages[code],
});
