import { Schema } from "effect";

import { AgentTimelineEntry } from "./agent-browser.ts";
import { AgentSessionVariableState, DemoSiteId } from "./agent-decision.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { DraftEmulation } from "./emulation.ts";
import { FlowSkillName } from "./flow-skill-identifiers.ts";
import { optionalNullable } from "./optional-field.ts";
import { RunVideoTimeMap } from "./run-video.ts";
import { scanRequirementsField, scanReportsField } from "./scans.ts";
import { TeachingRecordingId } from "./teaching-recording-identifiers.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * One Interactive Run of a verified Flow Skill. It is a durable artifact with
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
 * What the Runner observed, as distinct from what the agent concluded, so a
 * system fact is never dressed up as a model judgment. `timed-out` is legacy:
 * Runs once had wall-clock ceilings, and a Run Summary persisted before they
 * were removed may still carry it
 * ([ADR 0043](../../../docs/adr/0043-agent-runs-have-no-wall-clock-ceiling.md)).
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
}).annotate({
  message:
    'Evidence item needs {kind,id}: kind must be "snapshot" or "attempt" and id must be a non-empty string',
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
   * `null` until the Step is assessed, and still `null` on a legacy
   * `timed-out` Step: a ceiling breach recorded no assessment.
   */
  assessment: Schema.NullOr(AgentAssessment),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  confirmation: Schema.Boolean,
  description: nonEmptyString,
  /** The step's own "Done when:" line, copied from SKILL.md. */
  doneWhen: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
  execution: AgentStepExecution,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: nonEmptyString,
  startedAt: Schema.NullOr(nonEmptyString),
}).annotate({ identifier: "AgentRunStep" });
export type AgentRunStep = typeof AgentRunStep.Type;

/**
 * The wall-clock ceilings a Run carried before they were removed. Only a Run
 * Summary persisted before then has one, so it is read and never written
 * ([ADR 0043](../../../docs/adr/0043-agent-runs-have-no-wall-clock-ceiling.md)).
 */
const LegacyAgentRunCeilings = Schema.Struct({
  extensions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runMs: positiveInt,
  stepMs: positiveInt,
});

/**
 * Which Agent Steps the Run actually reached. Coverage is deliberately not a
 * verdict about the website: a Run whose every executed Step was `not-working`
 * still has complete coverage, and a Run that stopped at Step one does not.
 * Coverage is complete only when every Step was assessed.
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
 * and neither says whether the website works. `timed-out` is legacy: a Run
 * Summary persisted while Runs had wall-clock ceilings may still carry it.
 */
export const AgentRunOutcome = Schema.Literals([
  "completed",
  "ended-early",
  "timed-out",
  "interrupted",
]);
export type AgentRunOutcome = typeof AgentRunOutcome.Type;

/** Live Run state, carried on the Agent Session snapshot Agent View reads. */
export const LegacyAgentRunState = Schema.Struct({
  /** `null` once no Step is active, which is every state after the Run ends. */
  activeStepIndex: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  assessmentCounts: AgentRunAssessmentCounts,
  attribution: AgentRunAttribution,
  coverage: AgentRunCoverage,
  endedAt: Schema.NullOr(nonEmptyString),
  /** The Flow Skill directory name this Run follows. */
  flowSkillName: FlowSkillName,
  /**
   * The ordinary declared inputs this Run was started with. A secret input is
   * declared in shouty snake case and supplied as a runtime Variable instead,
   * so no secret literal ever reaches a tool parameter or this state.
   */
  inputs: Schema.Array(
    Schema.Struct({ name: nonEmptyString, value: nonEmptyString })
  ),
  /**
   * When the agent last called a tool on this Run's session. It never ends the
   * Run: Workspace reads it only to say how long the agent has been idle.
   */
  lastAgentActivityAt: nonEmptyString,
  outcome: Schema.NullOr(AgentRunOutcome),
  runId: AgentRunId,
  startedAt: nonEmptyString,
  steps: Schema.Array(AgentRunStep).check(Schema.isMinLength(1)),
  title: nonEmptyString,
  /**
   * The Flow Skill's declared inputs. The Run asks for them again rather than
   * persisting literals, so the Workspace reports only whether each has been
   * supplied (ADR 0039).
   */
  variables: Schema.Array(AgentSessionVariableState),
});
export type LegacyAgentRunState = typeof LegacyAgentRunState.Type;

/** Compatibility for the ordered runtime until task execution is integrated. */
export const AgentRunState = LegacyAgentRunState;
export type AgentRunState = LegacyAgentRunState;

/**
 * The persisted Run Summary. It outlives the Agent Session and the MCP process
 * that produced it, and `open_run` reads exactly this
 * ([ADR 0030](../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
export const LegacyAgentRunSummary = Schema.Struct({
  /**
   * The agent's closing account of the Run as a whole. It is absent unless the
   * agent offered one: a Run that ends on its own writes its Summary before
   * any account exists, and nothing invents one on the agent's behalf.
   */
  agentAccount: Schema.optional(nonEmptyString),
  assessmentCounts: AgentRunAssessmentCounts,
  attribution: AgentRunAttribution,
  /** Present only on a Summary persisted while Runs had ceilings. */
  ceilings: Schema.optional(LegacyAgentRunCeilings),
  coverage: AgentRunCoverage,
  endedAt: nonEmptyString,
  flowSkillName: FlowSkillName,
  /** Ordinary declared inputs. Secret values are runtime Variables, not these. */
  inputs: Schema.Array(
    Schema.Struct({ name: nonEmptyString, value: nonEmptyString })
  ),
  outcome: AgentRunOutcome,
  runId: AgentRunId,
  schemaVersion: Schema.Literal(2),
  /** The Agent Session that performed it, for correlating with Run history. */
  sessionId: AgentSessionId,
  startedAt: nonEmptyString,
  steps: Schema.Array(AgentRunStep).check(Schema.isMinLength(1)),
  /** Earlier version 2 writers used this nullable closing-account field. */
  summary: Schema.optional(Schema.NullOr(nonEmptyString)),
  timeline: Schema.Array(AgentTimelineEntry),
  title: nonEmptyString,
  /** Relative to the Run's directory; `null` when capture produced none. */
  tracePath: Schema.NullOr(nonEmptyString),
  videoPath: Schema.NullOr(nonEmptyString),
}).annotate({ identifier: "LegacyAgentRunSummary" });
export type LegacyAgentRunSummary = typeof LegacyAgentRunSummary.Type;

/** Version 1 predates Flow Skills; retain its identities and original account. */
export const LegacyAgentFlowRunSummary = Schema.Struct({
  agentFlowId: Schema.String.check(
    Schema.isPattern(/^flow-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
  ),
  assessmentCounts: AgentRunAssessmentCounts,
  attribution: AgentRunAttribution,
  ceilings: LegacyAgentRunCeilings,
  coverage: AgentRunCoverage,
  endedAt: nonEmptyString,
  outcome: AgentRunOutcome,
  revisionId: Schema.String.check(
    Schema.isPattern(/^rev-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
  ),
  runId: AgentRunId,
  schemaVersion: Schema.Literal(1),
  sessionId: AgentSessionId,
  startedAt: nonEmptyString,
  steps: Schema.Array(
    Schema.Struct({
      ...AgentRunStep.fields,
      // Version 1 did not copy a Done when line into its Step records.
      doneWhen: Schema.optional(nonEmptyString),
    })
  ).check(Schema.isMinLength(1)),
  summary: Schema.NullOr(nonEmptyString),
  timeline: Schema.Array(AgentTimelineEntry),
  title: nonEmptyString,
  tracePath: Schema.NullOr(nonEmptyString),
  videoPath: Schema.NullOr(nonEmptyString),
}).annotate({ identifier: "LegacyAgentFlowRunSummary" });
export type LegacyAgentFlowRunSummary = typeof LegacyAgentFlowRunSummary.Type;

/** A skill requested by the user, including requests made after startup. */
export const AgentRunSkillReference = Schema.Struct({
  flowSkillName: FlowSkillName,
  /**
   * `example` marks a read-only Example Flow Skill bundled with Contingency
   * rather than a user-verified catalog skill (ADR 0050).
   */
  origin: Schema.optional(Schema.Literal("example")),
  referencedAt: nonEmptyString,
});
export type AgentRunSkillReference = typeof AgentRunSkillReference.Type;

/** The skill and name together identify an input. Secret literals never travel. */
export const AgentRunInputIdentity = Schema.Struct({
  flowSkillName: FlowSkillName,
  name: nonEmptyString,
});
export type AgentRunInputIdentity = typeof AgentRunInputIdentity.Type;

export const AgentRunTaskInput = Schema.Struct({
  ...AgentRunInputIdentity.fields,
  value: nonEmptyString,
});
export type AgentRunTaskInput = typeof AgentRunTaskInput.Type;

export const AgentRunTaskVariable = Schema.Struct({
  ...AgentSessionVariableState.fields,
  flowSkillName: FlowSkillName,
  lastAnswer: Schema.optional(Schema.Literals(["supplied", "refused"])),
});
export type AgentRunTaskVariable = typeof AgentRunTaskVariable.Type;

/** User redirection is append-only and does not replace the original task. */
export const AgentRunInstruction = Schema.Struct({
  instruction: nonEmptyString,
  receivedAt: nonEmptyString,
});
export type AgentRunInstruction = typeof AgentRunInstruction.Type;

/** References recorded browser evidence, never raw Trace or video bytes. */
export const AgentTaskEvidence = Schema.Struct({
  id: nonEmptyString,
  kind: Schema.Literals(["snapshot", "attempt", "screenshot", "artifact"]),
});
export type AgentTaskEvidence = typeof AgentTaskEvidence.Type;

export const AgentTaskAssessment = Schema.Struct({
  evidence: Schema.Array(AgentTaskEvidence).check(Schema.isMinLength(1)),
  explanation: nonEmptyString,
  outcome: AgentAssessmentOutcome,
  /** Required for Dry Run reports: whether the complete skill outcome was attempted. */
  outcomeComplete: Schema.optional(Schema.Boolean),
  submittedAt: nonEmptyString,
});
export type AgentTaskAssessment = typeof AgentTaskAssessment.Type;

/** Findings record observations without ending execution or implying coverage. */
export const AgentTaskFinding = Schema.Struct({
  ...AgentTaskAssessment.fields,
  id: nonEmptyString,
});
export type AgentTaskFinding = typeof AgentTaskFinding.Type;

/** An execution ending is independent of the nullable task assessment. */
export const AgentTaskRunOutcome = Schema.Literals([
  "completed",
  "user-closed",
  "process-exited",
  "crashed",
  "interrupted",
]);
export type AgentTaskRunOutcome = typeof AgentTaskRunOutcome.Type;

export const AgentTaskRunPurpose = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interactive") }),
  Schema.Struct({
    flowSkillName: FlowSkillName,
    kind: Schema.Literal("dry-run"),
    recordingId: TeachingRecordingId,
    takeoverOccurred: Schema.Boolean,
  }),
]);
export type AgentTaskRunPurpose = typeof AgentTaskRunPurpose.Type;

const taskRunFields = {
  assessment: Schema.NullOr(AgentTaskAssessment),
  attribution: AgentRunAttribution,
  /**
   * Present when the Run's Domain Scope is a bundled demo site, so demo
   * evidence in the user's catalog is never mistaken for a real website's.
   */
  demoSite: Schema.optional(DemoSiteId),
  findings: Schema.Array(AgentTaskFinding),
  inputs: Schema.Array(AgentRunTaskInput),
  instructions: Schema.Array(AgentRunInstruction),
  purpose: AgentTaskRunPurpose,
  referencedSkills: Schema.Array(AgentRunSkillReference),
  requestedTask: nonEmptyString,
  runId: AgentRunId,
  scanReports: scanReportsField,
  scanRequirements: scanRequirementsField,
  schemaVersion: Schema.Literal(3),
  startedAt: nonEmptyString,
  startingEmulation: DraftEmulation,
  title: nonEmptyString,
  variables: Schema.Array(AgentRunTaskVariable),
};

const TaskAgentRunRecord = Schema.Struct(taskRunFields);

const taskInputIdentity = Schema.makeFilter(
  (run: typeof TaskAgentRunRecord.Type) => {
    const skills = new Set(
      run.referencedSkills.map((skill) => skill.flowSkillName)
    );
    for (const inputs of [run.inputs, run.variables]) {
      const identities = new Set<string>();
      for (const input of inputs) {
        if (!skills.has(input.flowSkillName)) {
          return "Inputs and Variables must belong to a referenced Flow Skill.";
        }
        const identity = JSON.stringify([input.flowSkillName, input.name]);
        if (identities.has(identity)) {
          return "Input and Variable identities must be unique within their Flow Skill.";
        }
        identities.add(identity);
      }
    }
    const secrets = new Set<string>();
    for (const variable of run.variables) {
      if (variable.secret) {
        secrets.add(JSON.stringify([variable.flowSkillName, variable.name]));
      }
    }
    return run.inputs.some((input) =>
      secrets.has(JSON.stringify([input.flowSkillName, input.name]))
    )
      ? "Secret Variable literals cannot be stored as ordinary inputs."
      : undefined;
  }
);

/** No active Step, step assessments, tallies, or coverage in task executions. */
export const TaskAgentRunState = Schema.Struct({
  ...taskRunFields,
  lastAgentActivityAt: nonEmptyString,
  lifecycle: Schema.Union([
    Schema.Struct({ phase: Schema.Literal("running") }),
    Schema.Struct({
      endedAt: nonEmptyString,
      outcome: AgentTaskRunOutcome,
      phase: Schema.Literal("ended"),
    }),
  ]),
}).check(taskInputIdentity);
export type TaskAgentRunState = typeof TaskAgentRunState.Type;

export const TaskAgentRunSummary = Schema.Struct({
  ...taskRunFields,
  agentAccount: Schema.optional(nonEmptyString),
  endedAt: nonEmptyString,
  outcome: AgentTaskRunOutcome,
  sessionId: AgentSessionId,
  timeline: Schema.Array(AgentTimelineEntry),
  tracePath: Schema.NullOr(nonEmptyString),
  videoPath: Schema.NullOr(nonEmptyString),
  /** Absent when no video was captured, and on Summaries written before it. */
  videoTimeMap: Schema.optional(RunVideoTimeMap),
})
  .check(taskInputIdentity)
  .annotate({ identifier: "TaskAgentRunSummary" });
export type TaskAgentRunSummary = typeof TaskAgentRunSummary.Type;

/** Historical step executions retain their version and meaning on decode. */
export const AgentRunSummary = Schema.Union([
  LegacyAgentFlowRunSummary,
  LegacyAgentRunSummary,
  TaskAgentRunSummary,
]);
export type AgentRunSummary = typeof AgentRunSummary.Type;

/** Contract only: task-directed runtime tools are integrated in later phases. */
export const AgentTaskRunStart = Schema.Struct({
  clientName: optionalNullable(nonEmptyString),
  clientVersion: optionalNullable(nonEmptyString),
  inputs: Schema.Array(AgentRunTaskInput),
  operationId: OperationId,
  referencedSkills: Schema.Array(FlowSkillName),
  reportedModel: optionalNullable(nonEmptyString),
  reportedProvider: optionalNullable(nonEmptyString),
  requestedTask: nonEmptyString,
  url: nonEmptyString,
});
export type AgentTaskRunStart = typeof AgentTaskRunStart.Type;

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

/**
 * Start an Interactive Run of a verified Flow Skill. There is no revision to
 * name: the Flow Skill directory in the selected Catalog Root is the single
 * reusable source of truth (ADR 0039).
 */
export const FlowSkillRunStart = Schema.Struct({
  clientName: optionalNullable(nonEmptyString),
  clientVersion: optionalNullable(nonEmptyString),
  flowSkillName: FlowSkillName,
  /**
   * The ordinary declared inputs, supplied again for this Run. A secret input
   * is declared in shouty snake case and is refused here: Contingency asks the
   * user for it as a runtime Variable so the literal never enters a tool call.
   */
  inputs: Schema.Array(
    Schema.Struct({ name: nonEmptyString, value: nonEmptyString })
  ),
  operationId: OperationId,
  /** Client-asserted, stored unverified. */
  reportedModel: optionalNullable(nonEmptyString),
  reportedProvider: optionalNullable(nonEmptyString),
  /** Where the Run opens. The Flow Skill's first step names the page. */
  url: nonEmptyString,
});
export type FlowSkillRunStart = typeof FlowSkillRunStart.Type;

export const AgentRunStepAssess = Schema.Struct({
  evidence: AgentAssessment.fields.evidence,
  explanation: AgentAssessment.fields.explanation,
  operationId: OperationId,
  outcome: AgentAssessmentOutcome,
  sessionId: AgentSessionId,
});
export type AgentRunStepAssess = typeof AgentRunStepAssess.Type;

export const AgentRunComplete = Schema.Struct({
  /** The agent's closing account of the Run, recorded on its Run Summary. */
  agentAccount: optionalNullable(nonEmptyString),
  operationId: OperationId,
  sessionId: AgentSessionId,
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
