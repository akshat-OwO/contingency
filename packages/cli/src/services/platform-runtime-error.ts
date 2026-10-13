import type { PlatformRuntimeError } from "./platform-runtime.ts";

const messages = {
  capability_missing:
    "The experimental Android runtime does not support a required capability. Private input, coordinate input, and Teaching capture are unavailable.",
  capture_incomplete:
    "Android capture is incomplete or obscured. Execution is paused.",
  cleanup_failed:
    "Android cleanup is incomplete. Retained owned state requires inspection before recovery.",
  device_disconnected:
    "The selected Android device is disconnected. Execution is paused.",
  device_mismatch:
    "The selected Android device identity changed. Execution is paused.",
  device_selection_required:
    "Explicitly select a prepared local API 36 emulator, serial, AVD, and build fingerprint.",
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
  runtime_closed: "The Android runtime is closed.",
  runtime_failed:
    "The Android backend failed. Execution is paused; dispatched input may have an uncertain outcome.",
  runtime_paused:
    "Android execution is paused. Explicitly recover the same selected device before continuing.",
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
