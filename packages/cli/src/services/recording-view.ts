import type { TeachingRecordingManifest } from "@contingency/protocol";

/** Rebind persisted evidence to the process currently serving Workspace. */
export const recordingViewUrl = (
  baseUrl: string,
  recordingId: string
): string => {
  const url = new URL("/", baseUrl);
  url.searchParams.set("recording", recordingId);
  return url.href;
};

/** Exclude learning claims and capture artifacts from the read-only report. */
export const recordingView = (manifest: TeachingRecordingManifest) => {
  const { lifecycle } = manifest;
  const latestDecision = manifest.receipts.findLast(
    (receipt) =>
      receipt.operation === "reject" || receipt.operation === "verification"
  );
  if (lifecycle._tag === "verified") {
    return { decision: "verified" as const, result: null, summary: null };
  }
  if (
    lifecycle._tag === "dry-run-passed" ||
    lifecycle._tag === "dry-run-failed"
  ) {
    return {
      decision: "pending" as const,
      result: lifecycle.dryRunResult,
      summary: lifecycle.dryRunSummary ?? null,
    };
  }
  const review = manifest.rejectedDryRun;
  return {
    decision:
      lifecycle._tag === "flow-drafted" &&
      latestDecision?.operation === "reject"
        ? ("rejected" as const)
        : ("pending" as const),
    result: review?.result ?? null,
    summary: review?.summary ?? null,
  };
};

/** Video routes need only the retained Summary, including after rejection. */
export const recordingDryRunSummary = (manifest: TeachingRecordingManifest) => {
  const { lifecycle } = manifest;
  if (
    lifecycle._tag === "dry-run-passed" ||
    lifecycle._tag === "dry-run-failed"
  ) {
    return lifecycle.dryRunSummary ?? null;
  }
  return lifecycle._tag === "verified"
    ? null
    : (manifest.rejectedDryRun?.summary ?? null);
};
