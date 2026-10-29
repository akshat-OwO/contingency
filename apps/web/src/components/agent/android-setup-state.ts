import {
  androidSupportedApi,
  isAndroidSupportedApi,
} from "@contingency/protocol";
import type {
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
} from "@contingency/protocol";

/** A device the runtime can open a session on, as a selection. */
export const selectable = (
  device: AndroidDiscoveredDevice
): AndroidWorkspaceSelection["device"] | null => {
  const { api, fingerprint } = device;
  if (
    device.state !== "device" ||
    !isAndroidSupportedApi(api) ||
    fingerprint === null ||
    device.release === null
  ) {
    return null;
  }
  if (device.kind === "physical") {
    return null;
  }
  return device.avd === null
    ? null
    : {
        api,
        avd: device.avd,
        fingerprint,
        host: "local",
        serial: device.serial,
      };
};

/** The release a selectable device reports; Preparation rechecks it. */
export const deviceRelease = (device: AndroidDiscoveredDevice | undefined) =>
  device?.release ?? "";

/** Why a reported device cannot be picked, or nothing when it can. */
export const unavailableReason = (device: AndroidDiscoveredDevice) => {
  if (device.kind === "physical") {
    return "physical_device_unsupported: Select an Android emulator";
  }
  if (device.state === "stopped") {
    return "Stopped. Start in Android Studio, then refresh";
  }
  if (device.state === "unauthorized") {
    return "Allow USB debugging on the device";
  }
  if (device.state !== "device") {
    return device.state === "offline" ? "Offline" : "Unavailable";
  }
  if (!isAndroidSupportedApi(device.api)) {
    return `API ${device.api ?? "unknown"}; needs API ${androidSupportedApi.minimum}–${androidSupportedApi.maximum}`;
  }
  return selectable(device) === null ? "Identity unreadable" : null;
};

const permissionLine =
  /^(?<decision>grant|revoke)\s+(?<permission>android\.permission\.[A-Z_]+)$/u;
export const parseAndroidPermissionDecisions = (
  text: string
):
  | NonNullable<AndroidWorkspaceSelection["environment"]["permissions"]>
  | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = lines.flatMap((line) => {
    const groups = permissionLine.exec(line)?.groups;
    const permission = groups?.permission;
    const decision = groups?.decision;
    return permission && (decision === "grant" || decision === "revoke")
      ? [
          { decision, permission } satisfies NonNullable<
            AndroidWorkspaceSelection["environment"]["permissions"]
          >[number],
        ]
      : [];
  });
  return entries.length === lines.length &&
    new Set(entries.map((entry) => entry.permission)).size === entries.length
    ? entries
    : undefined;
};
