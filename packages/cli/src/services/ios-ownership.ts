import { Effect } from "effect";

import type { PlatformRuntimeError } from "./platform-runtime.ts";

export type IosOwnershipReason =
  | "ax_query_timeout"
  | "ax_query_failed"
  | "ax_no_primary_app"
  | "ax_device_missing"
  | "ax_automation_unavailable"
  | "ax_pid_changed"
  | "ax_bundle_changed"
  | "helper_transport"
  | "helper_timeout"
  | "helper_reply_invalid"
  | "device_mismatch"
  | "bundle_mismatch"
  | "app_state_mismatch"
  | "alert_present_or_unknown"
  | "snapshot_transport"
  | "snapshot_bundle_mismatch"
  | "snapshot_truncated"
  | "snapshot_activation_metadata"
  | "snapshot_alert"
  | "snapshot_viewport_missing"
  | "snapshot_generation_missing";

export const iosOwnershipError = (
  reason: IosOwnershipReason
): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "ownership_unknown",
  message: "The Target App's foreground ownership could not be established.",
  ownershipReason: reason,
});

export const logIosOwnershipError = (cause: PlatformRuntimeError) =>
  Effect.logWarning("iOS ownership refused", { reason: cause.ownershipReason });
