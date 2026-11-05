import type {
  AgentRunAssessmentCounts,
  AgentRunCoverage,
  AgentRunId,
  AgentRunStep,
  AgentRunSummary,
} from "@contingency/protocol";
import { agentRunVideoPath } from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import { CircleAlertIcon } from "lucide-react";

import { DryRunSummaryView } from "@/components/agent/dry-run-summary";
import { isTaskDryRunSummary } from "@/components/agent/dry-run-summary-state";
import { EvidenceReference } from "@/components/agent/evidence-reference";
import { RunVideo } from "@/components/agent/run-video";
import { TaskRunDetails } from "@/components/agent/task-run-details";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const executionLabel: Record<AgentRunStep["execution"], string> = {
  active: "In progress",
  assessed: "Assessed",
  pending: "Not started",
  "timed-out": "Timed out",
  unexecuted: "Not executed",
};

type SummaryRunStep = Omit<AgentRunStep, "doneWhen">;

const outcomeTone = (
  step: SummaryRunStep
): "default" | "destructive" | "outline" | "secondary" => {
  if (step.execution === "timed-out") {
    return "destructive";
  }
  switch (step.assessment?.outcome) {
    case "working": {
      return "default";
    }
    case "not-working": {
      return "destructive";
    }
    case "inconclusive":
    case "blocked": {
      return "secondary";
    }
    default: {
      return "outline";
    }
  }
};

/**
 * The ordered Agent Steps and what each of them produced. A `timed-out` Step
 * from a Run persisted while Runs had wall-clock ceilings is shown as exactly
 * that, with no assessment: the Runner never invented a judgment for it.
 */
const RunSteps = ({
  activeStepIndex,
  steps,
}: {
  readonly activeStepIndex: number | null;
  readonly steps: readonly SummaryRunStep[];
}) => (
  <ol aria-label="Agent Steps" className="divide-y rounded-lg border">
    {steps.map((step) => (
      <li className="space-y-1 p-3 text-sm" key={step.index}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 font-medium wrap-anywhere">
            {step.index + 1}. {step.name}
          </span>
          <Badge variant={outcomeTone(step)}>
            {step.assessment?.outcome ?? executionLabel[step.execution]}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">{step.description}</p>
        {step.index === activeStepIndex ? (
          <p className="text-xs font-medium">Active Agent Step</p>
        ) : null}
        {step.assessment === null ? null : (
          <>
            <p className="text-muted-foreground text-xs wrap-anywhere">
              {step.assessment.explanation}
            </p>
            <p className="text-muted-foreground text-xs">
              {step.assessment.attempts} attempt
              {step.assessment.attempts === 1 ? "" : "s"} ·{" "}
              {step.assessment.evidence.length} evidence reference
              {step.assessment.evidence.length === 1 ? "" : "s"}
            </p>
          </>
        )}
      </li>
    ))}
  </ol>
);

/**
 * Assessment tallies beside coverage, never folded together: a broken Agent
 * Step and the Steps that were never reached are two different facts
 * ([ADR 0034](../../../../docs/adr/0034-agent-assessments-do-not-create-regressions.md)).
 */
const RunTotals = ({
  assessmentCounts,
  coverage,
}: {
  readonly assessmentCounts: AgentRunAssessmentCounts;
  readonly coverage: AgentRunCoverage;
}) => (
  <dl className="divide-y rounded-lg border text-sm">
    <div className="flex items-start justify-between gap-3 p-3">
      <dt className="text-muted-foreground shrink-0">Coverage</dt>
      <dd className="text-right font-medium">
        {coverage.complete ? "Complete" : "Incomplete"} · {coverage.executed} of{" "}
        {coverage.total} Agent Steps executed
      </dd>
    </div>
    <div className="flex items-start justify-between gap-3 p-3">
      <dt className="text-muted-foreground shrink-0">Assessments</dt>
      <dd className="text-right font-medium">
        {assessmentCounts.working} working · {assessmentCounts.notWorking} not
        working · {assessmentCounts.inconclusive} inconclusive ·{" "}
        {assessmentCounts.blocked} blocked
      </dd>
    </div>
  </dl>
);

/**
 * The finished Run, with its local video embedded. Nothing here leaves the
 * machine: the video is served from the Run's own directory over loopback
 * ([ADR 0010](../../../../docs/adr/0010-run-video-is-unredacted.md)).
 */
/** A stored outcome code, said as words: `user-closed` reads "Closed by user". */
const OUTCOME_LABEL = new Map([
  ["completed", "Completed"],
  ["crashed", "Crashed"],
  ["interrupted", "Interrupted"],
  ["process-exited", "Agent process exited"],
  ["user-closed", "Closed by user"],
]);

const outcomeLabel = (outcome: string): string => {
  const known = OUTCOME_LABEL.get(outcome);
  if (known !== undefined) {
    return known;
  }
  const words = outcome.replaceAll(/[_-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const RunSummaryView = ({
  heading = true,
  summary,
  videoSrc,
}: {
  /** Whether the view names itself; a page that already says so passes false. */
  readonly heading?: boolean;
  readonly summary: AgentRunSummary;
  readonly videoSrc?: string;
}) => {
  if (isTaskDryRunSummary(summary)) {
    return <DryRunSummaryView summary={summary} videoSrc={videoSrc} />;
  }
  const account =
    summary.schemaVersion === 1
      ? summary.summary
      : (summary.agentAccount ??
        (summary.schemaVersion === 2 ? summary.summary : undefined));
  const video = (
    <section aria-labelledby="agent-run-video" className="space-y-2">
      <h2
        className="text-base leading-snug font-semibold tracking-tight"
        id="agent-run-video"
      >
        Run video
      </h2>
      {summary.videoPath === null ? (
        <p className="text-muted-foreground text-xs">
          This Run recorded no video.
        </p>
      ) : (
        <RunVideo
          note="The video and Trace stay on this machine. Nothing is uploaded without your direct confirmation."
          src={videoSrc ?? agentRunVideoPath(summary.runId)}
          timeMap={
            summary.schemaVersion === 3 ? summary.videoTimeMap : undefined
          }
          timeline={summary.timeline}
        />
      )}
    </section>
  );
  return (
    <div className="space-y-5">
      <section aria-label="Run Summary" className="space-y-2">
        {heading ? (
          <h2 className="text-base leading-snug font-semibold tracking-tight">
            Run Summary
          </h2>
        ) : null}
        <div className="space-y-3 rounded-xl border p-4 text-sm">
          <div className="space-y-2">
            <p className="text-base leading-snug font-semibold text-pretty wrap-anywhere">
              {summary.title ?? summary.runId}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {summary.schemaVersion === 3 ? (
                <Badge variant="outline">
                  {summary.purpose.kind === "dry-run"
                    ? "Dry Run"
                    : "Interactive Run"}
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-xs">
                Execution outcome
              </span>
              <Badge
                variant={
                  summary.outcome === "completed" ? "default" : "secondary"
                }
              >
                {outcomeLabel(summary.outcome)}
              </Badge>
            </div>
          </div>
          {account === undefined || account === null ? null : (
            <p className="text-muted-foreground text-pretty wrap-anywhere">
              {account}
            </p>
          )}
          <div className="border-t pt-3">
            <EvidenceReference id={summary.runId} kind="Run ID" />
          </div>
          <p className="text-muted-foreground text-xs">
            The live browser was closed when this Run ended. This view is
            read-only.
          </p>
        </div>
      </section>
      {/* The replay follows what the agent concluded, before the setup. */}
      {summary.schemaVersion === 3 ? (
        <TaskRunDetails afterResult={video} resultFirst run={summary} />
      ) : (
        <>
          <RunTotals
            assessmentCounts={summary.assessmentCounts}
            coverage={summary.coverage}
          />
          <RunSteps activeStepIndex={null} steps={summary.steps} />
          {video}
        </>
      )}
    </div>
  );
};

/**
 * The read-only viewer `open_run` returns. It reads only persisted evidence
 * and restores no browser state, so it works after the MCP process that
 * recorded the Run has exited.
 */
export const RunViewer = ({ runId }: { readonly runId: AgentRunId }) => {
  const { agentRunSummaryAtom } = useRpcDependencies();
  const result = useAtomValue(agentRunSummaryAtom(runId));
  if (result._tag === "Initial") {
    return (
      <p className="text-muted-foreground p-6 text-sm">Loading the Run…</p>
    );
  }
  if (result._tag === "Failure") {
    return (
      <Alert className="m-6" variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>This Run could not be opened</AlertTitle>
        <AlertDescription>
          {refusal(result) ??
            "No persisted Run Summary was found under the selected Catalog Root."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <main className="mx-auto h-[calc(100svh-3.5rem)] min-h-0 w-full max-w-3xl overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Run Summary</h1>
      <p className="text-muted-foreground mb-5 text-sm">
        A read-only view of persisted evidence. No browser was reopened.
      </p>
      <RunSummaryView heading={false} summary={result.value.summary} />
    </main>
  );
};
