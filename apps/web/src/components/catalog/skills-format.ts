import type {
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
};

export const runKindLabel = (run: CatalogRunEntry): string =>
  RUN_KIND[run.kind];

/** What a Run reports for itself when it has no Agent Assessment. */
export const runVerdict = (run: CatalogRunEntry): string =>
  run.assessment ?? run.outcome;

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
  ["skill-drafted", "Flow skill drafted"],
  ["verified", "Verified"],
]);

export const recordingPhaseLabel = (recording: CatalogRecordingEntry): string =>
  PHASE.get(recording.phase) ?? recording.phase;

const STEP_NUMBER = /^\s{0,3}\d+[.)]\s+/u;
const DONE_WHEN = /^\s*Done when:/u;

/**
 * A procedure step's instruction as one line: its text without the step
 * number, the `Done when:` line shown beside it, or bold markers.
 */
export const stepInstruction = (description: string): string =>
  description
    .split("\n")
    .filter((line) => !DONE_WHEN.test(line))
    .join(" ")
    .replace(STEP_NUMBER, "")
    .replaceAll("**", "")
    .replaceAll(/\s+/gu, " ")
    .trim();
