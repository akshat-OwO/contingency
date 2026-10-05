import { scanCoverage } from "@contingency/protocol";
import type {
  AgentAssessmentOutcome,
  AgentRunSummary,
  AgentTaskRunOutcome,
  AgentTaskRunPurpose,
  FlowSkillDryRunResult,
  TaskAgentRunSummary,
} from "@contingency/protocol";

/** A persisted task record whose purpose was a Dry Run of one Flow Skill. */
export type TaskDryRunSummary = TaskAgentRunSummary & {
  readonly purpose: Extract<AgentTaskRunPurpose, { readonly kind: "dry-run" }>;
};

export const isTaskDryRunSummary = (
  summary: AgentRunSummary
): summary is TaskDryRunSummary =>
  summary.schemaVersion === 3 && summary.purpose.kind === "dry-run";

/** A persisted task record of an Interactive Run the agent was asked to do. */
export type TaskInteractiveRunSummary = TaskAgentRunSummary & {
  readonly purpose: Extract<
    AgentTaskRunPurpose,
    { readonly kind: "interactive" }
  >;
};

export const isTaskInteractiveRunSummary = (
  summary: AgentRunSummary
): summary is TaskInteractiveRunSummary =>
  summary.schemaVersion === 3 && summary.purpose.kind === "interactive";

/**
 * One fact a task summary checks. A Dry Run must pass every one before the
 * user can verify the flow; an Interactive Run lists them as its record.
 */
export interface SummaryCheck {
  readonly label: string;
  readonly passed: boolean;
  /** What the record holds for this rule, in a few words. */
  readonly value: string;
}

const runOutcomeLabel: Record<AgentTaskRunOutcome, string> = {
  completed: "Completed",
  crashed: "Crashed",
  interrupted: "Interrupted",
  "process-exited": "Agent process exited",
  "user-closed": "Closed by user",
};

export const assessmentOutcomeLabel: Record<AgentAssessmentOutcome, string> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

/** The facts every task Run's record answers, whatever it was for. */
const taskRunChecks = (
  summary: TaskAgentRunSummary
): readonly SummaryCheck[] => {
  const scans = scanCoverage(summary);
  return [
    {
      label: "Required scans",
      passed: scans.complete,
      value: `${scans.fulfilled}/${scans.total} completed`,
    },
    {
      label: "Run finished",
      passed: summary.outcome === "completed",
      value: runOutcomeLabel[summary.outcome],
    },
    {
      label: "Agent assessment",
      passed: summary.assessment?.outcome === "working",
      value:
        summary.assessment === null
          ? "None submitted"
          : assessmentOutcomeLabel[summary.assessment.outcome],
    },
  ];
};

/**
 * The pass rule for a task Dry Run, one check per fact. The dock offers
 * `Verify flow` only when every check passes, and the summary lists the same
 * checks, so the two never disagree about why a Dry Run failed.
 */
export const dryRunChecks = (
  summary: TaskDryRunSummary
): readonly SummaryCheck[] => [
  ...taskRunChecks(summary),
  {
    label: "Full outcome attempted",
    passed: summary.assessment?.outcomeComplete === true,
    value: summary.assessment?.outcomeComplete === true ? "Yes" : "No",
  },
  {
    label: "No takeover",
    passed: !summary.purpose.takeoverOccurred,
    value: summary.purpose.takeoverOccurred
      ? "User took control"
      : "Agent only",
  },
];

export const dryRunChecksPass = (summary: TaskDryRunSummary): boolean =>
  dryRunChecks(summary).every((check) => check.passed);

/**
 * What an Interactive Run's record holds. It has no pass rule: the user asked
 * for a task rather than a rehearsal, so a Takeover or a partial outcome is
 * ordinary and stays out of the list.
 */
export const interactiveRunChecks = (
  summary: TaskInteractiveRunSummary
): readonly SummaryCheck[] => taskRunChecks(summary);

/** How a verdict reads: a pass, a failure, or something to look into. */
export type SummaryVerdictTone = "attention" | "failed" | "passed";

export interface SummaryVerdict {
  readonly label: string;
  readonly tone: SummaryVerdictTone;
}

const assessmentTone: Record<AgentAssessmentOutcome, SummaryVerdictTone> = {
  blocked: "attention",
  inconclusive: "attention",
  "not-working": "failed",
  working: "passed",
};

const unassessedTone: Record<AgentTaskRunOutcome, SummaryVerdictTone> = {
  completed: "attention",
  crashed: "failed",
  interrupted: "failed",
  "process-exited": "failed",
  "user-closed": "attention",
};

/**
 * The answer an Interactive Run gives about the task: the Agent Assessment
 * when the agent submitted one, and otherwise how the Run ended. A Run that
 * ended without an assessment never reads as a pass.
 */
export const interactiveRunVerdict = (
  summary: TaskInteractiveRunSummary
): SummaryVerdict => {
  if (summary.assessment !== null) {
    return {
      label: assessmentOutcomeLabel[summary.assessment.outcome],
      tone: assessmentTone[summary.assessment.outcome],
    };
  }
  return {
    label:
      summary.outcome === "completed"
        ? "No assessment"
        : runOutcomeLabel[summary.outcome],
    tone: unassessedTone[summary.outcome],
  };
};

/**
 * What the summary may claim about the Dry Run as a whole. A Runner result of
 * `failed` fails it even when every check passes: the observable outcome is a
 * system fact, not a report. Without that result, as in a persisted record
 * reopened by `open_run`, green checks are all the record proves, so the
 * verdict says exactly that instead of claiming a pass.
 */
export type DryRunVerdict = "checks-passed" | "failed" | "passed";

export const dryRunVerdict = (
  summary: TaskDryRunSummary,
  result: FlowSkillDryRunResult | undefined
): DryRunVerdict => {
  if (result?.outcome === "failed" || !dryRunChecksPass(summary)) {
    return "failed";
  }
  return result === undefined ? "checks-passed" : "passed";
};

/** `1m 04s`, or `42s` under a minute. */
export const runDuration = (summary: TaskAgentRunSummary): string => {
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(summary.endedAt) - Date.parse(summary.startedAt)) / 1000
    )
  );
  const minutes = Math.floor(seconds / 60);
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** Every evidence reference the assessment and findings point at. */
export const evidenceCount = (summary: TaskAgentRunSummary): number =>
  (summary.assessment?.evidence.length ?? 0) +
  summary.findings.reduce(
    (total, finding) => total + finding.evidence.length,
    0
  );
