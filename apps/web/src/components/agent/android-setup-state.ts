import type {
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
} from "@contingency/protocol";

/** The one Android release the experimental runtime supports. */
const SUPPORTED_API = 36;
export const SUPPORTED_RELEASE = "16";

/** A device the runtime can open a session on, as a selection. */
export const selectable = (
  device: AndroidDiscoveredDevice
): AndroidWorkspaceSelection["device"] | null => {
  if (
    device.state !== "device" ||
    device.api !== SUPPORTED_API ||
    device.fingerprint === null
  ) {
    return null;
  }
  if (device.kind === "physical") {
    return device.model === null
      ? null
      : {
          api: SUPPORTED_API,
          fingerprint: device.fingerprint,
          host: "local",
          kind: "physical",
          model: device.model,
          serial: device.serial,
        };
  }
  return device.avd === null
    ? null
    : {
        api: SUPPORTED_API,
        avd: device.avd,
        fingerprint: device.fingerprint,
        host: "local",
        serial: device.serial,
      };
};

/** Why a reported device cannot be picked, or nothing when it can. */
export const unavailableReason = (device: AndroidDiscoveredDevice) => {
  if (device.state === "unauthorized") {
    return "Allow USB debugging on the device";
  }
  if (device.state !== "device") {
    return device.state === "offline" ? "Offline" : "Unavailable";
  }
  if (device.api !== SUPPORTED_API) {
    return `API ${device.api ?? "unknown"}; needs API ${SUPPORTED_API}`;
  }
  return selectable(device) === null ? "Identity unreadable" : null;
};
