import type {
  AndroidWorkspaceSelection,
  AndroidWorkspaceSnapshot,
} from "@contingency/protocol";

export const androidDeviceLabel = (
  device: AndroidWorkspaceSelection["device"]
) => (device.kind === "physical" ? device.model : device.avd);

/**
 * The rail's title for an ended device session: Teaching records a journey
 * rather than running one, so it is not called a Run.
 */
export const deviceSummaryLabel = (kind: string) =>
  kind === "teaching" ? "Teaching Summary" : "Run Summary";

/** A session's cleanup state as one string, so a change is one comparison. */
export const deviceCleanupKey = (
  cleanup: AndroidWorkspaceSnapshot["cleanup"]
): string =>
  cleanup === null
    ? "none"
    : `${cleanup._tag}:${"retainedFiles" in cleanup ? cleanup.retainedFiles.length : 0}`;

/**
 * The Capture Gap that paused the session. A pause after unobserved Forwarded
 * Input also records `forwarded_input_unverified`, which names evidence the
 * input left, never why the session paused.
 */
export const pauseCodeOf = (captureGaps: readonly string[]) =>
  captureGaps.findLast((code) => code !== "forwarded_input_unverified");
