import type {
  AgentAssessmentOutcome,
  CatalogRecordingEntry,
  CatalogRunEntry,
} from "@contingency/protocol";
import { format, formatDistanceStrict } from "date-fns";

export const when = (iso: string): string =>
  format(new Date(iso), "MMM d, HH:mm");

export const runDuration = (run: CatalogRunEntry): string =>
  formatDistanceStrict(new Date(run.endedAt), new Date(run.startedAt));

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
export const runVerdict = (run: CatalogRunEntry): string =>
  run.assessment === null
    ? (OUTCOME.get(run.outcome) ?? words(run.outcome))
    : ASSESSMENT[run.assessment];

/** The dock's own badge names for each Teaching capture state. */
const PHASE = new Map([
  ["dry-run-failed", "Dry run failed"],
  ["dry-run-passed", "Dry run passed"],
  ["dry-running", "Dry run"],
  ["failed", "Recording failed"],
  ["finalizing", "Saving"],
  ["learning", "Learning"],
  ["ready", "Recording saved"],
  ["recording", "Recording"],
  ["setup", "Not recording"],
  ["flow-drafted", "Flow drafted"],
  ["verified", "Verified"],
]);

export const recordingPhaseLabel = (recording: CatalogRecordingEntry): string =>
  PHASE.get(recording.phase) ?? recording.phase;
