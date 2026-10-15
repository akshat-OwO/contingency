import type { AndroidWorkspaceSelection } from "@contingency/protocol";

export const androidDeviceLabel = (
  device: AndroidWorkspaceSelection["device"]
) => (device.kind === "physical" ? device.model : device.avd);
