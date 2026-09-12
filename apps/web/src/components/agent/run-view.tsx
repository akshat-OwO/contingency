import type {
  AgentRunAssessmentCounts,
  AgentRunCoverage,
  AgentRunId,
  AgentRunState,
  AgentRunStep,
  AgentRunSummary,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { agentRunVideoPath, OperationId } from "@contingency/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { CircleAlertIcon, TimerIcon } from "lucide-react";

import { refusal } from "@/components/agent/draft-review-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const operationId = () => OperationId.make(crypto.randomUUID());

/** How much one direct user gesture adds to a ceiling. */
const CEILING_EXTENSION_MS = 120_000;

const seconds = (milliseconds: number): string =>
  `${Math.max(Math.round(milliseconds / 1000), 0)}s`;

const executionLabel: Record<AgentRunStep["execution"], string> = {
  active: "In progress",
  assessed: "Assessed",
  pending: "Not started",
  "timed-out": "Timed out",
  unexecuted: "Not executed",
};

const outcomeTone = (
  step: AgentRunStep
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
 * The ordered Agent Steps and what each of them produced. A Step with no
 * assessment and a `timed-out` execution is shown as exactly that: the Runner
 * records the ceiling breach and never invents a judgment for it.
 */
const RunSteps = ({
  activeStepIndex,
  steps,
}: {
  readonly activeStepIndex: number | null;
  readonly steps: readonly AgentRunStep[];
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
 * The ceilings, and the only place either can be raised. There is deliberately
 * no MCP tool for this: a stuck agent cannot buy itself more time
 * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
const RunCeilings = ({
  run,
  sessionId,
}: {
  readonly run: AgentRunState;
  readonly sessionId: AgentSessionSnapshot["id"];
}) => {
  const { agentRunCeilingExtendMutation } = useRpcDependencies();
  const [extendResult, extend] = useAtom(agentRunCeilingExtendMutation);
  const failure = refusal(extendResult);
  const ended = run.outcome !== null;
  const request = (scope: "run" | "step") => () =>
    extend({
      payload: {
        data: {
          additionalMs: CEILING_EXTENSION_MS,
          operationId: operationId(),
          scope,
          sessionId,
        },
        type: "agent.run.ceiling.extend",
      },
    });
  return (
    <section aria-labelledby="agent-run-ceilings" className="space-y-2">
      <h2 className="text-sm font-semibold" id="agent-run-ceilings">
        Ceilings
      </h2>
      <div className="space-y-3 rounded-lg border p-3 text-sm">
        <p className="text-muted-foreground text-xs">
          The Run stops when either ceiling is reached. A breach is recorded as
          a timed-out execution outcome, not as an agent judgment.
        </p>
        <dl className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Run ceiling</dt>
            <dd className="font-medium">{seconds(run.ceilings.runMs)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">Agent Step ceiling</dt>
            <dd className="font-medium">{seconds(run.ceilings.stepMs)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">User extensions</dt>
            <dd className="font-medium">{run.ceilings.extensions}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={ended}
            onClick={request("step")}
            size="sm"
            type="button"
            variant="outline"
          >
            <TimerIcon aria-hidden="true" />
            Extend Agent Step ceiling
          </Button>
          <Button
            disabled={ended}
            onClick={request("run")}
            size="sm"
            type="button"
            variant="outline"
          >
            <TimerIcon aria-hidden="true" />
            Extend Run ceiling
          </Button>
        </div>
        {failure === undefined ? null : (
          <p className="text-destructive text-xs">{failure}</p>
        )}
      </div>
    </section>
  );
};

/** Who performed the Run, and which parts of that are the client's own claim. */
const RunAttribution = ({ run }: { readonly run: AgentRunState }) => (
  <section aria-labelledby="agent-run-attribution" className="space-y-2">
    <h2 className="text-sm font-semibold" id="agent-run-attribution">
      Agent
    </h2>
    <dl className="divide-y rounded-lg border text-sm">
      <div className="flex items-start justify-between gap-3 p-3">
        <dt className="text-muted-foreground shrink-0">MCP client</dt>
        <dd className="min-w-0 text-right font-medium break-words">
          {run.attribution.clientName} {run.attribution.clientVersion}
        </dd>
      </div>
      {run.attribution.reportedProvider === null &&
      run.attribution.reportedModel === null ? null : (
        <div className="flex items-start justify-between gap-3 p-3">
          <dt className="text-muted-foreground shrink-0">
            Reported model (unverified)
          </dt>
          <dd className="min-w-0 text-right font-medium break-words">
            {[run.attribution.reportedProvider, run.attribution.reportedModel]
              .filter((value) => value !== null)
              .join(" · ")}
          </dd>
        </div>
      )}
    </dl>
    {run.attribution.reportedProvider === null &&
    run.attribution.reportedModel === null ? null : (
      <p className="text-muted-foreground text-xs">
        The provider and model are whatever the client said they were.
        Contingency cannot check that claim and does not present it as one.
      </p>
    )}
  </section>
);

/**
 * The finished Run, with its local video embedded. Nothing here leaves the
 * machine: the video is served from the Run's own directory over loopback
 * ([ADR 0010](../../../../docs/adr/0010-run-video-is-unredacted.md)).
 */
export const RunSummaryView = ({
  summary,
}: {
  readonly summary: AgentRunSummary;
}) => (
  <div className="space-y-5">
    <section aria-labelledby="agent-run-summary" className="space-y-2">
      <h2 className="text-sm font-semibold" id="agent-run-summary">
        Run Summary
      </h2>
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">{summary.title ?? summary.runId}</p>
        <Badge
          variant={summary.outcome === "completed" ? "default" : "secondary"}
        >
          {summary.outcome}
        </Badge>
        <p className="font-mono text-xs wrap-anywhere">{summary.runId}</p>
        {summary.summary === null ? null : (
          <p className="text-muted-foreground text-xs wrap-anywhere">
            {summary.summary}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          The live browser was closed when this Run ended. This View is
          read-only.
        </p>
      </div>
    </section>
    <RunTotals
      assessmentCounts={summary.assessmentCounts}
      coverage={summary.coverage}
    />
    <RunSteps activeStepIndex={null} steps={summary.steps} />
    <section aria-labelledby="agent-run-video" className="space-y-2">
      <h2 className="text-sm font-semibold" id="agent-run-video">
        Run video
      </h2>
      {summary.videoPath === null ? (
        <p className="text-muted-foreground text-xs">
          This Run recorded no video.
        </p>
      ) : (
        <video
          aria-label="Recorded Run video"
          className="w-full rounded-lg border"
          controls
          preload="metadata"
          src={agentRunVideoPath(summary.runId)}
        >
          <track kind="captions" />
        </video>
      )}
      <p className="text-muted-foreground text-xs">
        The video and Trace stay on this machine. Nothing is uploaded without
        your direct confirmation.
      </p>
    </section>
  </div>
);

/** The live Interactive Run, as Agent View shows it beside the browser. */
export const RunDetails = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { run } = session;
  if (run === null) {
    return null;
  }
  return (
    <>
      <section aria-labelledby="agent-run" className="space-y-2">
        <h2 className="text-sm font-semibold" id="agent-run">
          Interactive Run
        </h2>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">{run.title}</p>
          <p className="font-mono text-xs wrap-anywhere">{run.revisionId}</p>
          {run.outcome === null ? null : (
            <Badge
              variant={run.outcome === "completed" ? "default" : "secondary"}
            >
              Run {run.outcome}
            </Badge>
          )}
          {run.outcome === "timed-out" ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>A ceiling was reached</AlertTitle>
              <AlertDescription>
                The active action was interrupted and recorded as timed out. No
                Agent Assessment was produced for that Agent Step.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </section>
      <RunTotals
        assessmentCounts={run.assessmentCounts}
        coverage={run.coverage}
      />
      <section aria-labelledby="agent-run-steps" className="space-y-2">
        <h2 className="text-sm font-semibold" id="agent-run-steps">
          Agent Steps
        </h2>
        <RunSteps activeStepIndex={run.activeStepIndex} steps={run.steps} />
      </section>
      <RunCeilings run={run} sessionId={session.id} />
      <RunAttribution run={run} />
    </>
  );
};

/**
 * Agent View in summary mode. It appears only once the Run has ended and its
 * Run Summary has been written, so a Run that stopped on a ceiling shows the
 * live Run's own account until the agent finalizes it
 * ([ADR 0030](../../../../docs/adr/0030-agent-view-is-separate-from-audit-view.md)).
 */
const EndedRunSummary = ({ runId }: { readonly runId: AgentRunId }) => {
  const { agentRunSummaryAtom } = useRpcDependencies();
  const result = useAtomValue(agentRunSummaryAtom(runId));
  // The Run Summary is written when the agent finalizes the Run. Until then —
  // and for a Run that ended on a ceiling and was never finalized — the live
  // Run's own account is the only thing there is to show.
  return result._tag === "Success" ? (
    <RunSummaryView summary={result.value.data.summary} />
  ) : null;
};

export const RunSummaryPanel = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { run } = session;
  return run === null || run.outcome === null ? null : (
    <EndedRunSummary runId={run.runId} />
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
      <h1 className="mb-1 text-lg font-semibold tracking-tight">Run Summary</h1>
      <p className="text-muted-foreground mb-5 text-xs">
        A read-only view of persisted evidence. No browser was reopened.
      </p>
      <RunSummaryView summary={result.value.data.summary} />
    </main>
  );
};
