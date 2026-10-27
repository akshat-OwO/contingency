import type { PlatformRuntimeError } from "./platform-runtime.ts";

const messages = {
  capability_missing:
    "The native-app runtime does not implement a required capability.",
  device_mismatch: "The selected device identity changed. Execution is paused.",
  execution_canceled:
    "Execution was canceled. Recover and take a fresh observation before continuing.",
  observation_stale:
    "Take a fresh observation before acting. Observations are consumed once.",
  permission_stale: "This decision is not pending for this Run.",
  preparation_required:
    "Complete preparation and all Run decisions before input.",
  runtime_closed: "The native-app runtime is closed.",
  runtime_paused:
    "Execution is paused. Explicitly recover the selected device before continuing.",
  starting_condition_failed:
    "The fresh observation did not satisfy the declared starting conditions.",
  target_unsupported: "The target is unsupported for this action.",
} as const;

export const nativeAppRuntimeError = (
  code: keyof typeof messages
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code,
  message: messages[code],
});
