import { Schema } from "effect";

import { AgentExecutionBoundary, AgentTimelineEntry } from "./agent-browser.ts";
import {
  AgentPendingDecision,
  AgentPendingDecisionResolution,
  AgentSessionVariableState,
} from "./agent-decision.ts";
import { AgentSessionController, AgentSessionId } from "./agent-identifiers.ts";
import {
  AgentRunCoverage,
  AgentRunId,
  AgentRunInputIdentity,
  AgentRunInstruction,
  AgentRunOutcome,
  AgentRunTaskVariable,
  AgentTaskAssessment,
  AgentTaskFinding,
  AgentTaskRunOutcome,
  AgentTaskRunPurpose,
} from "./agent-run.ts";
import {
  AgentSessionActivity,
  AgentSessionPhase,
  AgentTakeoverRequest,
} from "./agent-session.ts";
import type { AgentSessionSnapshot } from "./agent-session.ts";
import { FlowSkillName } from "./flow-skill-identifiers.ts";
import { optionalNullable } from "./optional-field.ts";
import { TeachingRecordingId } from "./teaching-recording-identifiers.ts";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * How much session state a session-returning MCP tool answers with. `full` is
 * the complete snapshot and stays the default. `compact` keeps what the next
 * decision needs and replaces history with counts.
 */
export const AgentSessionView = Schema.Literals(["full", "compact"]);
export type AgentSessionView = typeof AgentSessionView.Type;

/** An append-only list reduced to its size and newest member. */
const latestOf = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ count: nonNegativeInt, latest: Schema.NullOr(item) });

const CompactTaskRun = Schema.Struct({
  assessment: Schema.NullOr(AgentTaskAssessment),
  findings: latestOf(AgentTaskFinding),
  /** Identities only: the agent already holds the values it supplied. */
  inputs: Schema.Array(AgentRunInputIdentity),
  instructions: latestOf(AgentRunInstruction),
  kind: Schema.Literal("task"),
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("running") }),
    Schema.Struct({
      outcome: AgentTaskRunOutcome,
      phase: Schema.Literal("ended"),
    }),
  ]),
  purpose: AgentTaskRunPurpose,
  referencedSkills: Schema.Array(FlowSkillName),
  requestedTask: Schema.String,
  runId: AgentRunId,
  variables: Schema.Array(AgentRunTaskVariable),
});

/** A historical ordered Run, reduced to where it stands. */
const CompactOrderedRun = Schema.Struct({
  activeStepIndex: Schema.NullOr(nonNegativeInt),
  coverage: AgentRunCoverage,
  flowSkillName: FlowSkillName,
  kind: Schema.Literal("ordered"),
  outcome: Schema.NullOr(AgentRunOutcome),
  runId: AgentRunId,
  variables: Schema.Array(AgentSessionVariableState),
});

const CompactTeaching = Schema.Struct({
  actionCount: nonNegativeInt,
  /** The `_tag` of the Teaching capture state, such as `recording` or `ready`. */
  captureState: Schema.String,
  flowSkillName: FlowSkillName,
  instructionCount: nonNegativeInt,
  recordingId: TeachingRecordingId,
});

const CompactDryRun = Schema.Struct({
  flowSkillName: FlowSkillName,
  recordingId: TeachingRecordingId,
  variables: Schema.Array(AgentSessionVariableState),
});

/**
 * The decision-sized projection of an Agent Session. It is derived from the
 * full snapshot on every read, never stored, so it cannot drift from the state
 * the Workspace shows. Everything an agent must act on survives: open Pending
 * Decisions, a paused Execution Boundary, Takeover, the newest attempt, and the
 * Run's lifecycle, assessment, and unsupplied Variables. Older attempts and
 * resolved decisions are counted, and `agent_session_history_get` pages them.
 */
export const AgentSessionCompact = Schema.Struct({
  activity: AgentSessionActivity,
  boundary: Schema.NullOr(AgentExecutionBoundary),
  controller: AgentSessionController,
  currentUrl: Schema.String,
  dryRun: Schema.NullOr(CompactDryRun),
  error: Schema.NullOr(Schema.String),
  history: Schema.Struct({
    decisions: nonNegativeInt,
    timeline: nonNegativeInt,
  }),
  id: AgentSessionId,
  interruptedAction: Schema.NullOr(AgentTimelineEntry),
  latestAttempt: Schema.NullOr(AgentTimelineEntry),
  pendingDecisions: Schema.Array(AgentPendingDecision),
  phase: AgentSessionPhase,
  run: Schema.NullOr(Schema.Union([CompactTaskRun, CompactOrderedRun])),
  takeover: Schema.NullOr(AgentTakeoverRequest),
  teaching: Schema.NullOr(CompactTeaching),
  updatedAt: Schema.String,
  view: Schema.Literal("compact"),
  viewUrl: Schema.String,
});
export type AgentSessionCompact = typeof AgentSessionCompact.Type;

const latest = <T>(items: readonly T[]) => ({
  count: items.length,
  latest: items.at(-1) ?? null,
});

const compactRun = (
  run: AgentSessionSnapshot["run"]
): AgentSessionCompact["run"] => {
  if (run === null) {
    return null;
  }
  if ("schemaVersion" in run) {
    return {
      assessment: run.assessment,
      findings: latest(run.findings),
      inputs: run.inputs.map(({ flowSkillName, name }) => ({
        flowSkillName,
        name,
      })),
      instructions: latest(run.instructions),
      kind: "task",
      lifecycle:
        run.lifecycle.phase === "running"
          ? { phase: "running" }
          : { outcome: run.lifecycle.outcome, phase: "ended" },
      purpose: run.purpose,
      referencedSkills: run.referencedSkills.map(
        (skill) => skill.flowSkillName
      ),
      requestedTask: run.requestedTask,
      runId: run.runId,
      variables: run.variables,
    };
  }
  return {
    activeStepIndex: run.activeStepIndex,
    coverage: run.coverage,
    flowSkillName: run.flowSkillName,
    kind: "ordered",
    outcome: run.outcome,
    runId: run.runId,
    variables: run.variables,
  };
};

/** Projects a full snapshot to {@link AgentSessionCompact}. */
export const compactAgentSession = (
  snapshot: AgentSessionSnapshot
): AgentSessionCompact => ({
  activity: snapshot.activity,
  boundary: snapshot.boundary ?? null,
  controller: snapshot.controller,
  currentUrl: snapshot.currentUrl,
  dryRun:
    snapshot.dryRun === null
      ? null
      : {
          flowSkillName: snapshot.dryRun.flowSkillName,
          recordingId: snapshot.dryRun.recordingId,
          variables: snapshot.dryRun.variables,
        },
  error: snapshot.error ?? null,
  history: {
    decisions: snapshot.decisionHistory.length,
    timeline: snapshot.timeline.length,
  },
  id: snapshot.id,
  interruptedAction: snapshot.interruptedAction,
  latestAttempt: snapshot.timeline.at(-1) ?? null,
  pendingDecisions: snapshot.pendingDecisions,
  phase: snapshot.phase,
  run: compactRun(snapshot.run),
  takeover: snapshot.takeover,
  teaching:
    snapshot.activity === "teaching"
      ? {
          actionCount: snapshot.teaching.actionCount,
          captureState: snapshot.captureState._tag,
          flowSkillName: snapshot.flowSkillName,
          instructionCount: snapshot.teaching.instructionCount,
          recordingId: snapshot.recordingId,
        }
      : null,
  updatedAt: snapshot.updatedAt,
  view: "compact",
  viewUrl: snapshot.viewUrl,
});

/** The most entries one history page answers with. */
export const AGENT_SESSION_HISTORY_PAGE_MAX = 50;

/**
 * Pages an Agent Session's retained history, newest first. `before` is the id
 * (or `pendingDecisionId`) of the oldest entry a previous page returned; omit
 * it to start from the
 * newest entry.
 */
export const AgentSessionHistoryGet = Schema.Struct({
  before: optionalNullable(Schema.String.check(Schema.isMinLength(1))),
  kind: Schema.Literals(["timeline", "decisions"]),
  limit: optionalNullable(
    Schema.Int.check(
      Schema.isBetween({ maximum: AGENT_SESSION_HISTORY_PAGE_MAX, minimum: 1 })
    )
  ),
  sessionId: AgentSessionId,
});
export type AgentSessionHistoryGet = typeof AgentSessionHistoryGet.Type;

export const AgentSessionHistoryPage = Schema.Struct({
  decisions: Schema.Array(AgentPendingDecisionResolution),
  /** Pass as `before` for the next older page; `null` at the oldest entry. */
  nextBefore: Schema.NullOr(Schema.String),
  timeline: Schema.Array(AgentTimelineEntry),
  /** How many entries of this kind the session retains. */
  total: nonNegativeInt,
});
export type AgentSessionHistoryPage = typeof AgentSessionHistoryPage.Type;
