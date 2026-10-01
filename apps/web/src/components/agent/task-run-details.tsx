import type {
  AgentTaskAssessment,
  AgentTaskEvidence,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";

import { Badge } from "@/components/ui/badge";

const EvidenceReferences = ({
  evidence,
}: {
  readonly evidence: readonly AgentTaskEvidence[];
}) => (
  <ul
    aria-label="Browser evidence"
    className="text-muted-foreground space-y-1 text-xs"
  >
    {evidence.map((reference) => (
      <li className="wrap-anywhere" key={`${reference.kind}:${reference.id}`}>
        {reference.kind}: <code>{reference.id}</code>
      </li>
    ))}
  </ul>
);

const Assessment = ({
  assessment,
}: {
  readonly assessment: AgentTaskAssessment;
}) => (
  <div className="space-y-2 rounded-lg border p-3">
    <Badge
      variant={
        assessment.outcome === "not-working" ? "destructive" : "secondary"
      }
    >
      {assessment.outcome}
    </Badge>
    <p className="wrap-anywhere">{assessment.explanation}</p>
    <EvidenceReferences evidence={assessment.evidence} />
  </div>
);

/** The same task record is readable during execution and after persistence. */
export const TaskRunDetails = ({
  run,
}: {
  readonly run: TaskAgentRunState | TaskAgentRunSummary;
}) => (
  <div className="space-y-4 text-sm">
    <section aria-label="Requested task" className="space-y-2">
      <h3 className="font-semibold">Requested task</h3>
      <p className="wrap-anywhere">{run.requestedTask}</p>
      {run.instructions.length === 0 ? null : (
        <ol aria-label="Changed instructions" className="space-y-2">
          {run.instructions.map((instruction) => (
            <li
              className="wrap-anywhere"
              key={`${instruction.receivedAt}:${instruction.instruction}`}
            >
              {instruction.instruction}
            </li>
          ))}
        </ol>
      )}
    </section>
    <section aria-label="Referenced skills" className="space-y-2">
      <h3 className="font-semibold">Referenced skills</h3>
      {run.referencedSkills.length === 0 ? (
        <p>No Flow Skills referenced.</p>
      ) : (
        <ul className="space-y-1">
          {run.referencedSkills.map((skill) => (
            <li className="wrap-anywhere" key={skill.flowSkillName}>
              {skill.flowSkillName}
            </li>
          ))}
        </ul>
      )}
    </section>
    <section aria-label="Task assessment" className="space-y-2">
      <h3 className="font-semibold">Agent Assessment</h3>
      {run.assessment === null ? (
        <p>No Agent Assessment submitted.</p>
      ) : (
        <Assessment assessment={run.assessment} />
      )}
      {run.purpose.kind === "dry-run" ? (
        <p className="text-muted-foreground text-xs">
          {run.assessment?.outcomeComplete === true
            ? "The agent reports a complete skill outcome attempt."
            : "The agent did not report a complete skill outcome attempt."}
          {run.purpose.takeoverOccurred
            ? " User Takeover prevents this Dry Run from passing."
            : ""}
        </p>
      ) : null}
    </section>
    <section aria-label="Findings" className="space-y-2">
      <h3 className="font-semibold">Findings</h3>
      {run.findings.length === 0 ? (
        <p>No findings recorded.</p>
      ) : (
        <ul className="space-y-2">
          {run.findings.map((finding) => (
            <li key={finding.id}>
              <Assessment assessment={finding} />
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);
