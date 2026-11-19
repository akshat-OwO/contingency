import type {
  AgentPursuitEnding,
  AgentPursuitRecord,
  AgentTaskAssessment,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";
import { CornerDownRightIcon, SparklesIcon } from "lucide-react";

import {
  assessmentOutcomeLabel,
  noFindings,
} from "@/components/agent/dry-run-summary-state";
import { cn } from "@/lib/utils";

import { BrowserCheckResults } from "./browser-check-results";
import { BrowserModifications } from "./browser-modifications";
import { EvidenceList } from "./evidence-reference";
import {
  DetailEmpty,
  DetailFacts,
  DetailRow,
  DetailRowText,
  DetailRowTitle,
  DetailRows,
  DetailSection,
  DetailTime,
  FlowPill,
} from "./run-detail-parts";
import { runProvenance } from "./run-provenance.ts";
import { ScanResults } from "./scan-results.tsx";

type TaskRun = TaskAgentRunState | TaskAgentRunSummary;

const assessmentDot: Record<AgentTaskAssessment["outcome"], string> = {
  blocked: "[--dot:var(--status-needs-you)]",
  inconclusive: "[--dot:var(--muted-foreground)]",
  "not-working": "[--dot:var(--destructive)]",
  working: "[--dot:var(--status-ready)]",
};

const AssessmentDot = ({
  outcome,
}: {
  readonly outcome: AgentTaskAssessment["outcome"];
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "mx-1 mt-1.5 size-2 shrink-0 rounded-full bg-(--dot) shadow-[0_0_0_3px_color-mix(in_oklch,var(--dot)_18%,transparent)]",
      assessmentDot[outcome]
    )}
  />
);

const Assessment = ({
  assessment,
  hint = false,
}: {
  readonly assessment: AgentTaskAssessment;
  /** The run's own assessment says how evidence is used; findings do not. */
  readonly hint?: boolean;
}) => (
  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 text-[13px]">
    <AssessmentDot outcome={assessment.outcome} />
    <div className="grid min-w-0 gap-1">
      <p className="font-medium">
        {assessmentOutcomeLabel[assessment.outcome]}
      </p>
      <p className="text-muted-foreground text-pretty wrap-anywhere">
        {assessment.explanation}
      </p>
      <EvidenceList evidence={assessment.evidence} hint={hint} />
    </div>
  </div>
);

const ENDING: Record<AgentPursuitEnding, string> = {
  blocked: "Blocked",
  done: "Done",
  "needs-input": "Needs input",
  paused: "Paused",
  unsure: "Unsure",
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Sub-goals the agent delegated to System One. Its actions sit on the same
 * timeline as the agent's own, so this is how a reviewer tells them apart
 * ([ADR 0057](../../../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 */
export const Pursuits = ({ run }: { readonly run: TaskRun }) => {
  const pursuits: readonly AgentPursuitRecord[] = run.pursuits ?? [];
  if (pursuits.length === 0) {
    return null;
  }
  return (
    <DetailSection
      label="System One Pursuits"
      meta={`${pursuits.length} delegated`}
    >
      <DetailRows>
        {pursuits.map((pursuit) => (
          <DetailRow
            // A retried call records the same step again, ended later.
            key={`${pursuit.operationId}:${pursuit.step ?? 1}:${pursuit.endedAt}`}
            lead={
              <SparklesIcon
                aria-hidden="true"
                className={cn(
                  "mt-px size-4 shrink-0",
                  pursuit.ending === "done"
                    ? "text-status-running"
                    : "text-muted-foreground"
                )}
              />
            }
          >
            <DetailRowTitle
              status={ENDING[pursuit.ending]}
              tone={pursuit.ending === "done" ? "passed" : "open"}
            >
              {pursuit.goal}
            </DetailRowTitle>
            <DetailRowText>{pursuit.reason}</DetailRowText>
            {pursuit.actions.length === 0 ? null : (
              <ol
                aria-label="Model-chosen attempts"
                className="bg-island-hover text-muted-foreground mt-1.5 grid gap-0.5 rounded-lg px-2 py-1.5 text-xs"
              >
                {pursuit.actions.map((action) => (
                  <li
                    className="flex flex-wrap gap-x-2.5 gap-y-0.5"
                    key={action.attemptId}
                  >
                    <code className="wrap-anywhere">{action.attemptId}</code>{" "}
                    <span className="[&_b]:text-foreground [&_b]:font-medium [&_b]:tabular-nums">
                      operation <b>{percent(action.confidence.operation)}</b> ·
                      target <b>{percent(action.confidence.target)}</b>
                      {action.confidence.value === null ? null : (
                        <>
                          {" "}
                          · value <b>{percent(action.confidence.value)}</b>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </DetailRow>
        ))}
      </DetailRows>
    </DetailSection>
  );
};

/** What the agent was asked, as the user gave it and changed it. */
export const RequestedTask = ({
  label = "Requested task",
  run,
}: {
  /** `Intended outcome` on a Dry Run. */
  readonly label?: string;
  readonly run: TaskRun;
}) => {
  const provenance = runProvenance(run);
  return (
    <DetailSection label={label}>
      <p className="bg-island-hover rounded-xl px-3 py-2.5 text-[13.5px] text-pretty wrap-anywhere">
        {run.requestedTask}
      </p>
      {provenance.demoSiteName === undefined ? null : (
        <DetailRowText>
          {provenance.example
            ? `A bundled Example on the ${provenance.demoSiteName} demo store. It demonstrates Contingency and is not your verified work.`
            : `Demo work on the ${provenance.demoSiteName} demo store, not a real website.`}
        </DetailRowText>
      )}
      {run.instructions.length === 0 ? null : (
        <ol aria-label="Changed instructions" className="grid gap-1.5">
          {run.instructions.map((instruction) => (
            <li
              className="text-muted-foreground flex gap-1.5 text-[12.5px] wrap-anywhere"
              key={`${instruction.receivedAt}:${instruction.instruction}`}
            >
              <CornerDownRightIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              {instruction.instruction}
            </li>
          ))}
        </ol>
      )}
    </DetailSection>
  );
};

export const ReferencedFlows = ({ run }: { readonly run: TaskRun }) => (
  <DetailSection heading="Referenced Flows" label="Referenced flows">
    {run.referencedFlows.length === 0 ? (
      <DetailEmpty>No Flows referenced.</DetailEmpty>
    ) : (
      <ul className="flex flex-wrap gap-1.5">
        {run.referencedFlows.map((flow) => (
          <li className="max-w-full" key={flow.flowName}>
            <FlowPill
              example={flow.origin === "example"}
              name={flow.flowName}
            />
          </li>
        ))}
      </ul>
    )}
  </DetailSection>
);

const emulationChange = (
  before: { readonly pageZoom?: number; readonly textScale?: number },
  after: { readonly pageZoom?: number; readonly textScale?: number }
) => {
  const changes: string[] = [];
  if ((before.pageZoom ?? 100) !== (after.pageZoom ?? 100)) {
    changes.push(
      `Page zoom ${before.pageZoom ?? 100}% → ${after.pageZoom ?? 100}%`
    );
  }
  if ((before.textScale ?? 100) !== (after.textScale ?? 100)) {
    changes.push(
      `Text scale ${before.textScale ?? 100}% → ${after.textScale ?? 100}%`
    );
  }
  return changes.length === 0
    ? `Page zoom ${after.pageZoom ?? 100}%, text scale ${after.textScale ?? 100}%`
    : changes.join(", ");
};

export const EmulationSection = ({ run }: { readonly run: TaskRun }) => {
  const { viewport } = run.startingEmulation;
  const changes = run.emulationChanges ?? [];
  return (
    <DetailSection label="Emulation">
      <DetailFacts>
        <dt>Viewport</dt>
        <dd className="tabular-nums">
          {viewport.width}×{viewport.height}
        </dd>
        <dt>Page zoom</dt>
        <dd className="tabular-nums">
          {run.startingEmulation.pageZoom ?? 100}%
        </dd>
        <dt>Text scale</dt>
        <dd className="tabular-nums">
          {run.startingEmulation.textScale ?? 100}%
        </dd>
      </DetailFacts>
      {changes.length === 0 ? null : (
        <DetailRows label="Emulation changes" ordered>
          {changes.map((change) => (
            <DetailRow key={change.id} lead={<DetailTime at={change.at} />}>
              <p>{emulationChange(change.before, change.after)}</p>
              <DetailRowText>
                {change.actor === "agent" ? "The agent" : "You"}
              </DetailRowText>
            </DetailRow>
          ))}
        </DetailRows>
      )}
    </DetailSection>
  );
};

/** The same task record is readable during execution and after persistence. */
export const TaskRunDetails = ({
  afterResult,
  resultFirst = false,
  run,
}: {
  /** What follows the result when it leads, such as the Run's video. */
  readonly afterResult?: React.ReactNode;
  /**
   * A finished Run leads with what the agent concluded; a live one leads with
   * what it was asked, since it has not concluded anything yet.
   */
  readonly resultFirst?: boolean;
  readonly run: TaskRun;
}) => {
  const live = !resultFirst;
  const result = (
    <>
      <Pursuits run={run} />
      <DetailSection heading="Agent Assessment" label="Task assessment">
        {run.assessment === null ? (
          <DetailEmpty>
            {live
              ? "Not submitted yet. The agent assesses the task when it finishes."
              : "No Agent Assessment submitted."}
          </DetailEmpty>
        ) : (
          <Assessment assessment={run.assessment} hint />
        )}
        {run.purpose.kind === "dry-run" ? (
          <DetailRowText>
            {run.assessment?.outcomeComplete === true
              ? "The agent reports a complete flow outcome attempt."
              : "The agent did not report a complete flow outcome attempt."}
            {run.purpose.takeoverOccurred
              ? " User Takeover prevents this Dry Run from passing."
              : ""}
          </DetailRowText>
        ) : null}
      </DetailSection>
      <DetailSection
        label="Findings"
        meta={run.findings.length === 0 ? undefined : run.findings.length}
      >
        {run.findings.length === 0 ? (
          <DetailEmpty>
            {live ? "No findings yet." : noFindings(run.assessment !== null)}
          </DetailEmpty>
        ) : (
          <ul className="grid gap-3.5">
            {run.findings.map((finding) => (
              <li key={finding.id}>
                <Assessment assessment={finding} />
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </>
  );
  return (
    <div className="grid min-w-0 gap-[18px] text-sm">
      {resultFirst ? (
        <>
          {result}
          {afterResult}
        </>
      ) : null}
      <RequestedTask
        label={
          run.purpose.kind === "dry-run" ? "Intended outcome" : "Requested task"
        }
        run={run}
      />
      <ReferencedFlows run={run} />
      <EmulationSection run={run} />
      <BrowserModifications modifications={run.browserModifications ?? []} />
      <BrowserCheckResults run={run} />
      <ScanResults run={run} />
      {resultFirst ? null : result}
    </div>
  );
};
