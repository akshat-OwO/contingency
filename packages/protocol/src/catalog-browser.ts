import { Schema } from "effect";

import { DemoSiteId } from "./agent-decision.ts";
import { AgentAssessmentOutcome, AgentRunId } from "./agent-run.ts";
import { FlowSkillName } from "./flow-skill-identifiers.ts";
import { TeachingRecordingId } from "./teaching-recording-identifiers.ts";
import { FlowSkillFile } from "./teaching-recording.ts";

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

/** One Flow Skill directory as the Workspace lists it. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowSkillEntry = Schema.Struct({
  /** Present when the skill's hosts are a bundled demo site. */
  demo: Schema.optional(DemoSiteId),
  description: Schema.String,
  hosts: Schema.Array(nonEmptyString),
  name: FlowSkillName,
  stepCount: count,
  /** The user verified it; otherwise it is a draft awaiting its Dry Run. */
  verified: Schema.Boolean,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowSkillEntry = typeof CatalogFlowSkillEntry.Type;

/**
 * One persisted Run, reduced to what tells it apart in a list. `legacy`
 * covers step-based Summaries written before task Runs.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRunEntry = Schema.Struct({
  assessment: Schema.NullOr(AgentAssessmentOutcome),
  endedAt: nonEmptyString,
  /** The Flow Skills the Run referenced, which is what groups it. */
  flowSkillNames: Schema.Array(FlowSkillName),
  kind: Schema.Literals(["interactive", "dry-run", "legacy"]),
  outcome: nonEmptyString,
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
  flowSkillName: FlowSkillName,
  keyframeCount: count,
  /** The recording's capture state tag, such as `skill-drafted`. */
  phase: nonEmptyString,
  recordingId: TeachingRecordingId,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogRecordingEntry = typeof CatalogRecordingEntry.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogRootView = Schema.Struct({
  flowSkills: Schema.Array(CatalogFlowSkillEntry),
  path: nonEmptyString,
  /** Whether a `.contingency` directory exists at `path`. */
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
export const CatalogFlowSkillGet = Schema.Struct({
  name: FlowSkillName,
  scope: CatalogRootScope,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowSkillGet = typeof CatalogFlowSkillGet.Type;

// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowSkillStep = Schema.Struct({
  description: nonEmptyString,
  doneWhen: Schema.String,
  name: nonEmptyString,
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowSkillStep = typeof CatalogFlowSkillStep.Type;

/** A Flow Skill package to read: its files as written, and its procedure. */
// oxlint-disable-next-line eslint/no-redeclare
export const CatalogFlowSkillResult = Schema.Struct({
  entry: CatalogFlowSkillEntry,
  files: Schema.Array(FlowSkillFile),
  steps: Schema.Array(CatalogFlowSkillStep),
});
// oxlint-disable-next-line eslint/no-redeclare
export type CatalogFlowSkillResult = typeof CatalogFlowSkillResult.Type;
