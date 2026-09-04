import { Schema } from "effect";

import { AgentTimelineEntry } from "./agent-browser.ts";
import {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentSessionVariableState,
} from "./agent-flow.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * One Interactive Run of an Approved Agent Flow. It is a durable artifact with
 * its own identity: an Agent Session is the ephemeral envelope that performed
 * it, and dies with its MCP process, while the Run outlives both
 * ([ADR 0029](../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
export const AgentRunId = Schema.String.check(
  Schema.isPattern(/^agentrun-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
).pipe(Schema.brand("@contingency/AgentRunId"));
export type AgentRunId = typeof AgentRunId.Type;

/**
 * The external agent's judgment of one Agent Step. It is a model opinion, not
 * a machine-checked fact, which is why it is stored apart from the execution
 * outcome and never becomes a Regression on its own
 * ([ADR 0034](../../../docs/adr/0034-agent-assessments-do-not-create-regressions.md)).
 */
export const AgentAssessmentOutcome = Schema.Literals([
  "working",
  "not-working",
  "inconclusive",
  "blocked",
]);
export type AgentAssessmentOutcome = typeof AgentAssessmentOutcome.Type;

/** Only `working` advances; every other judgment ends the Run's coverage. */
export const advancesAgentRun = (outcome: AgentAssessmentOutcome): boolean =>
  outcome === "working";

/**
 * What the Runner observed, as distinct from what the agent concluded. A
 * ceiling breach is `timed-out` here and produces no Agent Assessment at all,
 * so a system fact is never dressed up as a model judgment.
 */
export const AgentStepExecution = Schema.Literals([
  "pending",
  "active",
  "assessed",
  "timed-out",
  "unexecuted",
]);
export type AgentStepExecution = typeof AgentStepExecution.Type;

/**
 * What the agent pointed at to justify its assessment. Every reference must
 * name something the Runner recorded during that Agent Step — a Browser
 * Snapshot it minted or an attempt it timed — so an explanation cannot cite
 * evidence that does not exist.
 */
export const AgentAssessmentEvidence = Schema.Struct({
  id: nonEmptyString,
  kind: Schema.Literals(["snapshot", "attempt"]),
});
export type AgentAssessmentEvidence = typeof AgentAssessmentEvidence.Type;

export const AgentAssessment = Schema.Struct({
  /** How many attempts the agent made inside the Step before concluding. */
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  evidence: Schema.Array(AgentAssessmentEvidence).check(Schema.isMinLength(1)),
  explanation: nonEmptyString,
  outcome: AgentAssessmentOutcome,
  submittedAt: nonEmptyString,
});
export type AgentAssessment = typeof AgentAssessment.Type;

/** One ordered Agent Step as the Run executed — or did not execute — it. */
export const AgentRunStep = Schema.Struct({
  /**
   * `null` until the Step is assessed, and still `null` when it timed out: a
   * ceiling breach records no assessment.
   */
  assessment: Schema.NullOr(AgentAssessment),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  confirmation: Schema.Boolean,
  description: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
  execution: AgentStepExecution,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: nonEmptyString,
  startedAt: Schema.NullOr(nonEmptyString),
});
export type AgentRunStep = typeof AgentRunStep.Type;

/**
 * How much wall clock the Run and its current Agent Step have. Both are
 * explicit rather than inherited, and only a direct user action in Agent View
 * extends either ([ADR 0021](../../../docs/adr/0021-timeouts-are-set-not-inherited.md)).
 */
export const AgentRunCeilings = Schema.Struct({
  /** How many times the user has extended a ceiling in this Run. */
  extensions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runMs: positiveInt,
  stepMs: positiveInt,
});
export type AgentRunCeilings = typeof AgentRunCeilings.Type;

/**
 * Which Agent Steps the Run actually reached. Coverage is deliberately not a
 * verdict about the website: a Run whose every executed Step was `not-working`
 * still has complete coverage, and a Run that stopped at Step one does not.
 */
export const AgentRunCoverage = Schema.Struct({
  complete: Schema.Boolean,
  executed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  unexecuted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentRunCoverage = typeof AgentRunCoverage.Type;

/** Assessment tallies, reported beside coverage rather than folded into it. */
export const AgentRunAssessmentCounts = Schema.Struct({
  blocked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inconclusive: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  notWorking: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  working: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentRunAssessmentCounts = typeof AgentRunAssessmentCounts.Type;

/**
 * Which agent host performed the Run. The MCP client name and version are
 * observed by Contingency from the session that made the calls. Provider and
 * model are whatever the client said they were, and are recorded as
 * unverified: useful attribution must not read as an identity guarantee.
 */
export const AgentRunAttribution = Schema.Struct({
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
  /** Always false. Contingency cannot check a client's claim about itself. */
  reportedMetadataVerified: Schema.Literal(false),
  reportedModel: Schema.NullOr(nonEmptyString),
  reportedProvider: Schema.NullOr(nonEmptyString),
});
export type AgentRunAttribution = typeof AgentRunAttribution.Type;

/**
 * How the Run stopped, as a system fact. It is separate from the assessments:
 * `ended-early` means a terminal Agent Assessment stopped the ordered Steps,
 * `timed-out` means a ceiling did, and neither says whether the website works.
 */
export const AgentRunOutcome = Schema.Literals([
  "completed",
  "ended-early",
  "timed-out",
  "interrupted",
]);
export type AgentRunOutcome = typeof AgentRunOutcome.Type;

/** Live Run state, carried on the Agent Session snapshot Agent View reads. */
export const AgentRunState = Schema.Struct({
  /** `null` once no Step is active, which is every state after the Run ends. */
  activeStepIndex: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  agentFlowId: AgentFlowId,
  assessmentCounts: AgentRunAssessmentCounts,
  attribution: AgentRunAttribution,
  ceilings: AgentRunCeilings,
  coverage: AgentRunCoverage,
  endedAt: Schema.NullOr(nonEmptyString),
  outcome: Schema.NullOr(AgentRunOutcome),
  revisionId: AgentFlowRevisionId,
  runDeadline: nonEmptyString,
  runId: AgentRunId,
  startedAt: nonEmptyString,
  /** `null` when no Agent Step is active. */
  stepDeadline: Schema.NullOr(nonEmptyString),
  steps: Schema.Array(AgentRunStep).check(Schema.isMinLength(1)),
  title: nonEmptyString,
  /**
   * The Agent Flow's runtime Variables. The Run asks for them again rather
   * than persisting literals, so Agent View reports only whether each has been
   * supplied ([ADR 0032](../../../docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)).
   */
  variables: Schema.Array(AgentSessionVariableState),
});
export type AgentRunState = typeof AgentRunState.Type;

/**
 * The persisted Run Summary. It outlives the Agent Session and the MCP process
 * that produced it, and `open_run` reads exactly this
 * ([ADR 0030](../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
export const AgentRunSummary = Schema.Struct({
  agentFlowId: AgentFlowId,
  assessmentCounts: AgentRunAssessmentCounts,
  attribution: AgentRunAttribution,
  ceilings: AgentRunCeilings,
  coverage: AgentRunCoverage,
  endedAt: nonEmptyString,
  outcome: AgentRunOutcome,
  revisionId: AgentFlowRevisionId,
  runId: AgentRunId,
  schemaVersion: Schema.Literal(1),
  /** The Agent Session that performed it, for correlating with Run history. */
  sessionId: AgentSessionId,
  startedAt: nonEmptyString,
  steps: Schema.Array(AgentRunStep).check(Schema.isMinLength(1)),
  /** The agent's optional closing account of the Run as a whole. */
  summary: Schema.NullOr(nonEmptyString),
  timeline: Schema.Array(AgentTimelineEntry),
  title: nonEmptyString,
  /** Relative to the Run's directory; `null` when capture produced none. */
  tracePath: Schema.NullOr(nonEmptyString),
  videoPath: Schema.NullOr(nonEmptyString),
});
export type AgentRunSummary = typeof AgentRunSummary.Type;

/**
 * Where Agent View fetches a finished Run's video. It is a local loopback path
 * served from the Run's own directory: no adapter uploads it
 * ([ADR 0010](../../../docs/adr/0010-run-video-is-unredacted.md)).
 */
export const agentRunVideoPath = (runId: AgentRunId | string): string =>
  `/agent-runs/${runId}/video`;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const AgentFlowRunStart = Schema.Struct({
  agentFlowId: AgentFlowId,
  clientName: Schema.optional(nonEmptyString),
  clientVersion: Schema.optional(nonEmptyString),
  operationId: OperationId,
  /** Client-asserted, stored unverified. */
  reportedModel: Schema.optional(nonEmptyString),
  reportedProvider: Schema.optional(nonEmptyString),
  /** The approved head when omitted. Only approved revisions may be run. */
  revisionId: Schema.optional(AgentFlowRevisionId),
  runCeilingMs: Schema.optional(positiveInt),
  stepCeilingMs: Schema.optional(positiveInt),
});
export type AgentFlowRunStart = typeof AgentFlowRunStart.Type;

export const AgentRunStepAssess = Schema.Struct({
  evidence: AgentAssessment.fields.evidence,
  explanation: AgentAssessment.fields.explanation,
  operationId: OperationId,
  outcome: AgentAssessmentOutcome,
  sessionId: AgentSessionId,
});
export type AgentRunStepAssess = typeof AgentRunStepAssess.Type;

export const AgentRunComplete = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
  summary: Schema.optional(nonEmptyString),
});
export type AgentRunComplete = typeof AgentRunComplete.Type;

export const AgentRunOpen = Schema.Struct({
  runId: AgentRunId,
});
export type AgentRunOpen = typeof AgentRunOpen.Type;

/** A read-only local viewer over persisted Run evidence. */
export const AgentRunViewer = Schema.Struct({
  summary: AgentRunSummary,
  /** Local, loopback, and read-only: no browser state is restored. */
  viewUrl: nonEmptyString,
});
export type AgentRunViewer = typeof AgentRunViewer.Type;

/** Which ceiling a direct user action in Agent View extended, and by how much. */
export const AgentRunCeilingExtend = Schema.Struct({
  additionalMs: positiveInt,
  operationId: OperationId,
  scope: Schema.Literals(["run", "step"]),
  sessionId: AgentSessionId,
});
export type AgentRunCeilingExtend = typeof AgentRunCeilingExtend.Type;
