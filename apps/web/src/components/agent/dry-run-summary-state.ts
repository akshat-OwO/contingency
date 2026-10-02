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

/** One rule a task Dry Run must meet before the user can verify the flow. */
export interface DryRunCheck {
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

/**
 * The pass rule for a task Dry Run, one check per fact. The dock offers
 * `Verify flow` only when every check passes, and the summary lists the same
 * checks, so the two never disagree about why a Dry Run failed.
 */
export const dryRunChecks = (
  summary: TaskDryRunSummary
): readonly DryRunCheck[] => [
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
