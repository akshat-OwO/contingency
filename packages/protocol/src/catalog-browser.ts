import { Schema } from "effect";

import { DemoSiteId } from "./agent-decision.ts";
import { AgentAssessmentOutcome, AgentRunId } from "./agent-run.ts";
import { FlowName } from "./flow-identifiers.ts";
import { TeachingRecordingId } from "./teaching-recording-identifiers.ts";
import { FlowFile } from "./teaching-recording.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Where a browsed Catalog Root lives. `local` is the Catalog Root this
 * process serves; `global` is the user's `~/.contingency`, which only the
 * Workspace lists, read-only, and no agent ever reads (ADR 0051).
 */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRootScope = Schema.Literals(["local", "global"]);
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogRootScope = typeof CatalogRootScope.Type;

/** One Flow directory as the Workspace lists it. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowEntry = Schema.Struct({
  /** Present when the flow's hosts are a bundled demo site. */
  demo: Schema.optional(DemoSiteId),
  description: Schema.String,
  /** Group directory segments relative to the Catalog Root. */
  groupPath: Schema.Array(nonEmptyString),
  hosts: Schema.Array(nonEmptyString),
  name: FlowName,
  stepCount: count,
  /** The user verified it; otherwise it is a draft awaiting its Dry Run. */
  verified: Schema.Boolean,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowEntry = typeof CatalogFlowEntry.Type;

/**
 * One persisted Run, reduced to what tells it apart in a list. `legacy`
 * covers step-based Summaries written before task Runs.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRunEntry = Schema.Struct({
  assessment: Schema.NullOr(AgentAssessmentOutcome),
  endedAt: nonEmptyString,
  /** The agent's own sentence for its assessment, when it gave one. */
  explanation: Schema.optional(Schema.String),
  /** How many findings the agent recorded beside its assessment. */
  findingCount: Schema.optionalKey(Schema.Number),
  /** The Flows the Run referenced; storage ownership is independent. */
  flowNames: Schema.Array(FlowName),
  kind: Schema.Literals(["interactive", "dry-run", "legacy"]),
  outcome: nonEmptyString,
  /** The containing Flow, or null for a Run stored at the Catalog Root. */
  ownerFlow: Schema.NullOr(FlowName),
  /** The Teaching Recording a Dry Run belongs to; `null` for other Runs. */
  recordingId: Schema.NullOr(TeachingRecordingId),
  runId: AgentRunId,
  startedAt: nonEmptyString,
  title: nonEmptyString,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogRunEntry = typeof CatalogRunEntry.Type;

/** One Teaching Recording's manifest, without its sensitive artifacts. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRecordingEntry = Schema.Struct({
  cleanup: Schema.Literals(["pending", "purge-pending", "purged"]),
  createdAt: nonEmptyString,
  flowName: FlowName,
  keyframeCount: count,
  /** The containing Flow directory, including a recordings-only draft. */
  ownerFlow: FlowName,
  /** The recording's capture state tag, such as `flow-drafted`. */
  phase: nonEmptyString,
  recordingId: TeachingRecordingId,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogRecordingEntry = typeof CatalogRecordingEntry.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRootView = Schema.Struct({
  flows: Schema.Array(CatalogFlowEntry),
  path: nonEmptyString,
  /** Whether a Catalog Root directory exists at `path`. */
  present: Schema.Boolean,
  recordings: Schema.Array(CatalogRecordingEntry),
  runs: Schema.Array(CatalogRunEntry),
  scope: CatalogRootScope,
  /** Run Summaries and manifests that could not be decoded and were left out. */
  unreadable: count,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogRootView = typeof CatalogRootView.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogBrowseGet = Schema.Struct({});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogBrowseGet = typeof CatalogBrowseGet.Type;

/** Local first; the global root follows only when it is a different directory. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogBrowseResult = Schema.Struct({
  roots: Schema.Array(CatalogRootView),
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogBrowseResult = typeof CatalogBrowseResult.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowGet = Schema.Struct({
  name: FlowName,
  scope: CatalogRootScope,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowGet = typeof CatalogFlowGet.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowStep = Schema.Struct({
  description: nonEmptyString,
  doneWhen: Schema.String,
  name: nonEmptyString,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowStep = typeof CatalogFlowStep.Type;

/** A Flow package to read: its files as written, and its procedure. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowResult = Schema.Struct({
  entry: CatalogFlowEntry,
  files: Schema.Array(FlowFile),
  steps: Schema.Array(CatalogFlowStep),
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowResult = typeof CatalogFlowResult.Type;
