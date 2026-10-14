import type { PlatformRuntimeError } from "./platform-runtime.ts";

const messages = {
  capability_missing:
    "The experimental Android runtime does not support a required capability. Coordinate input and Teaching capture are unavailable; private input needs the private text helper.",
  capture_incomplete:
    "Android capture is incomplete or obscured. Execution is paused.",
  cleanup_failed:
    "Android cleanup is incomplete. Retained owned state requires inspection before recovery.",
  clear_data_denied:
    "Authorize clearing the Target App data on this selected device before preparation.",
  device_disconnected:
    "The selected Android device is disconnected. Execution is paused.",
  device_mismatch:
    "The selected Android device identity changed. Execution is paused.",
  device_selection_required:
    "Explicitly select a local API 36 device by serial and identity.",
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
  observation_stale:
    "Take a fresh Android observation before acting. Observations are consumed once.",
  ownership_unknown:
    "Android window ownership is unknown or outside the selected target app. Execution is paused.",
  permission_stale: "This decision is not pending for this Run.",
  preparation_failed:
    "The declared Android setup is unsupported or failed. Input is blocked.",
  preparation_required:
    "Complete Android preparation and all Run decisions before input.",
  private_input_uncertain:
    "Private input may have reached the Android device but was not verified. Execution is paused; observe before continuing and do not retry.",
  runtime_closed: "The Android runtime is closed.",
  runtime_failed:
    "The Android backend failed. Execution is paused; dispatched input may have an uncertain outcome.",
  runtime_paused:
    "Android execution is paused. Explicitly recover the same selected device before continuing.",
  starting_condition_failed:
    "The fresh Android observation did not satisfy the declared starting conditions.",
  target_changed:
    "The observed Android field or window changed. No private input was sent; take a fresh observation.",
  target_unsupported:
    "The Android target is absent, covered, private, or unsupported for this action.",
} as const;

export const platformRuntimeError = (
  code: keyof typeof messages
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: messages[code],
});
