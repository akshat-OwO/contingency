import type { AndroidWorkspaceSelection } from "@contingency/protocol";

export const androidDeviceLabel = (
  device: AndroidWorkspaceSelection["device"]
) => (device.kind === "physical" ? device.model : device.avd);

/**
 * The rail's title for an ended device session: Teaching records a journey
 * rather than running one, so it is not called a Run.
 */
export const deviceSummaryLabel = (kind: string) =>
  kind === "teaching" ? "Teaching Summary" : "Run Summary";
