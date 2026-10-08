import type {
  AgentPursuitRecord,
  AgentTaskAssessment,
  AgentTaskEvidence,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";

import { Badge } from "@/components/ui/badge";

import { BrowserCheckResults } from "./browser-check-results";
import { runProvenance } from "./run-provenance.ts";
import { ScanResults } from "./scan-results.tsx";

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

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Sub-goals the agent delegated to System One. Its actions sit on the same
 * timeline as the agent's own, so this is how a reviewer tells them apart
 * ([ADR 0057](../../../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 */
const Pursuits = ({
  pursuits,
}: {
  readonly pursuits: readonly AgentPursuitRecord[];
}) => (
  <section aria-label="System One Pursuits" className="space-y-2">
    <h3 className="font-semibold">System One Pursuits</h3>
    <ul className="space-y-2">
      {pursuits.map((pursuit) => (
        <li
          className="space-y-2 rounded-lg border p-3"
          key={`${pursuit.operationId}:${pursuit.step ?? 1}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={pursuit.ending === "done" ? "secondary" : "outline"}
            >
              {pursuit.ending}
            </Badge>
            <span className="wrap-anywhere">{pursuit.goal}</span>
          </div>
          <p className="text-muted-foreground text-xs wrap-anywhere">
            {pursuit.reason}
          </p>
          {pursuit.actions.length === 0 ? null : (
            <ol
              aria-label="Model-chosen attempts"
              className="text-muted-foreground space-y-1 text-xs"
            >
              {pursuit.actions.map((action) => (
                <li className="wrap-anywhere" key={action.attemptId}>
                  <code>{action.attemptId}</code> operation{" "}
                  {percent(action.confidence.operation)}, target{" "}
                  {percent(action.confidence.target)}
                  {action.confidence.value === null
                    ? null
                    : `, value ${percent(action.confidence.value)}`}
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ul>
  </section>
);

/** The same task record is readable during execution and after persistence. */
export const TaskRunDetails = ({
  run,
}: {
  readonly run: TaskAgentRunState | TaskAgentRunSummary;
}) => {
  const provenance = runProvenance(run);
  return (
    <div className="space-y-4 text-sm">
      <section aria-label="Requested task" className="space-y-2">
        <h3 className="font-semibold">Requested task</h3>
        <p className="wrap-anywhere">{run.requestedTask}</p>
        {provenance.demoSiteName === undefined ? null : (
          <p className="text-muted-foreground text-xs">
            {provenance.example
              ? `A bundled Example on the ${provenance.demoSiteName} demo store. It demonstrates Contingency and is not your verified work.`
              : `Demo work on the ${provenance.demoSiteName} demo store, not a real website.`}
          </p>
        )}
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
              <li
                className="flex flex-wrap items-center gap-2 wrap-anywhere"
                key={skill.flowSkillName}
              >
                {skill.flowSkillName}
                {skill.origin === "example" ? (
                  <Badge variant="outline">Example</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <BrowserCheckResults run={run} />
      <ScanResults run={run} />
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
      {run.pursuits === undefined || run.pursuits.length === 0 ? null : (
        <Pursuits pursuits={run.pursuits} />
      )}
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
};
