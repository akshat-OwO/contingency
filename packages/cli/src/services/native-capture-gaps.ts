import type {
  AndroidWorkspaceSummary,
  NativeCaptureRepair,
} from "@contingency/protocol";

type GapSummary = Pick<
  AndroidWorkspaceSummary,
  "captureGaps" | "captureRepairs"
>;

/**
 * Gaps a fresh observation cannot repair: a secure window withheld its
 * content, and unverified Forwarded Input may have changed the device in a way
 * no later observation can account for.
 */
const UNREPAIRABLE = new Set(["secure_window", "forwarded_input_unverified"]);

/** The Capture Gaps no repair covers yet, in the order they occurred. */
export const openCaptureGaps = (summary: GapSummary): readonly string[] => {
  const repaired = new Map<string, number>();
  for (const repair of summary.captureRepairs ?? []) {
    repaired.set(repair.code, (repaired.get(repair.code) ?? 0) + 1);
  }
  return summary.captureGaps.filter((code) => {
    const remaining = repaired.get(code) ?? 0;
    if (remaining === 0) {
      return true;
    }
    repaired.set(code, remaining - 1);
    return false;
  });
};

/** Marks every open repairable gap repaired by a fresh same-device observation. */
export const repairCaptureGaps = <Summary extends GapSummary>(
  summary: Summary,
  by: NativeCaptureRepair["by"],
  at: string
): Summary => {
  const repairs: NativeCaptureRepair[] = [];
  for (const code of openCaptureGaps(summary)) {
    if (!UNREPAIRABLE.has(code)) {
      repairs.push({ at, by, code });
    }
  }
  return repairs.length === 0
    ? summary
    : {
        ...summary,
        captureRepairs: [...(summary.captureRepairs ?? []), ...repairs],
      };
};

/**
 * Whether the runtime may repair a capture failure itself: only an
 * agent-controlled Run or Dry Run. Teaching stays user-led, and the user's own
 * control of a Run is never interrupted by an automatic recovery.
 */
export const repairsCaptureAutomatically = (
  summary: Pick<AndroidWorkspaceSummary, "controller" | "kind" | "phase">
) =>
  summary.kind !== "teaching" &&
  summary.controller === "agent" &&
  summary.phase === "running";
