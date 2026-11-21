import type {
  AgentAssessmentOutcome,
  CatalogRecordingEntry,
  CatalogRunEntry,
} from "@contingency/protocol";
import { format } from "date-fns";

export const when = (iso: string): string =>
  format(new Date(iso), "MMM d, HH:mm");

/** How long a Run took, as a clock: `0:02`, `1:36`, `1:02:05`. */
export const runDuration = (run: CatalogRunEntry): string => {
  const elapsed = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  const total = Number.isFinite(elapsed)
    ? Math.max(0, Math.round(elapsed / 1000))
    : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours === 0
    ? `${minutes}:${seconds}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
};

const RUN_KIND: Record<CatalogRunEntry["kind"], string> = {
  "dry-run": "Dry Run",
  interactive: "Interactive Run",
  legacy: "Run",
  run: "Run",
};

const PLATFORM = { android: "Android", ios: "iOS" } as const;

export const runKindLabel = (run: CatalogRunEntry): string =>
  run.native === undefined
    ? RUN_KIND[run.kind]
    : `${PLATFORM[run.native.platform]} ${RUN_KIND[run.kind]}`;

const ASSESSMENT = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
} as const;

/** An Agent Assessment outcome in words. */
export const assessmentLabel = (outcome: AgentAssessmentOutcome): string =>
  ASSESSMENT[outcome];

const OUTCOME = new Map([
  ["completed", "Unassessed"],
  ["crashed", "Crashed"],
  ["interrupted", "Interrupted"],
  ["process-exited", "Agent process exited"],
  ["timed-out", "Timed out"],
  ["user-closed", "Closed by user"],
]);

/** An outcome code nobody named yet, said as words. */
const words = (code: string) => {
  const text = code.replaceAll(/[_-]+/gu, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * What a Run reports for itself, in words: its Agent Assessment, or how it
 * ended when the agent never assessed it.
 */
export const runVerdict = (
  run: Pick<CatalogRunEntry, "assessment" | "outcome">
): string =>
  run.assessment === null
    ? (OUTCOME.get(run.outcome) ?? words(run.outcome))
    : ASSESSMENT[run.assessment];

/**
 * Where a Teaching Recording stands, in the words the Flows page uses for it
 * (#755), by its capture state.
 */
const PHASE = new Map([
  ["dry-run-failed", "Dry Run failed"],
  ["dry-run-passed", "Dry Run passed"],
  ["dry-running", "Dry Run running"],
  ["failed", "Recording failed"],
  ["finalizing", "Saving"],
  ["flow-drafted", "Learned, Dry Run next"],
  ["learning", "Learning"],
  ["ready", "Recorded, learning next"],
  // Not "Recording": the row's chip already says what kind of entry it is.
  ["recording", "Capturing"],
  ["setup", "Not started"],
  ["verified", "Verified"],
]);

/**
 * A recording's phase in words. Once Cleanup removed its evidence, that is
 * what there is to say about it; a state nobody named yet reads as words.
 */
export const recordingPhaseLabel = (
  recording: CatalogRecordingEntry
): string =>
  recording.cleanup === "purged"
    ? "Cleaned up"
    : (PHASE.get(recording.phase) ?? words(recording.phase));
