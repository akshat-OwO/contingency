import { OperationId, dryRunVideoPath } from "@contingency/protocol";
import type {
  TeachingRecordingCleanupState,
  TeachingRecordingId,
} from "@contingency/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  DryRunSummaryView,
  FlowDecision,
  FlowDecisionButtons,
  VerifyFlowQuestion,
} from "@/components/agent/dry-run-summary";
import type { FlowDecisionTone } from "@/components/agent/dry-run-summary";
import {
  dryRunCannotVerify,
  isTaskDryRunSummary,
} from "@/components/agent/dry-run-summary-state";
import { RunSummaryView } from "@/components/agent/run-view";
import { Button } from "@/components/ui/button";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

/**
 * Where a Flow stands after its Dry Run, as one sentence (ADR 0073). Only a
 * passed Dry Run with a pending decision asks for one.
 */
const decisionSentence = (
  decision: "pending" | "rejected" | "verified",
  outcome: "failed" | "passed" | undefined,
  flow: ReactNode,
  cleanup: TeachingRecordingCleanupState
): ReactNode => {
  if (decision === "verified" && cleanup._tag === "purge-pending") {
    const kept =
      cleanup.retainedFiles.length === 0
        ? null
        : ` It kept ${cleanup.retainedFiles.join(", ")}.`;
    return (
      <>
        You verified {flow}, but Cleanup could not remove all of its Teaching
        evidence.{cleanup.failure === null ? null : ` ${cleanup.failure}`}
        {kept}
      </>
    );
  }
  if (decision === "verified") {
    return <>You verified {flow}. Cleanup removes its recording evidence.</>;
  }
  if (decision === "rejected") {
    return (
      <>
        You rejected {flow}. This evidence stays until the next Dry Run starts.
      </>
    );
  }
  if (outcome === "failed") {
    return dryRunCannotVerify;
  }
  if (outcome === "passed") {
    return <VerifyFlowQuestion flow={flow} />;
  }
  return "Awaiting your Verify or Reject decision.";
};

/** Persisted review only. Verification remains an explicit user decision. */
export const RecordingViewer = ({
  recordingId,
  sessionId = null,
}: {
  readonly recordingId: TeachingRecordingId;
  readonly sessionId?: string | null;
}) => {
  const {
    recordingViewAtom,
    agentTeachingFlowVerifyMutation,
    agentTeachingFlowRejectMutation,
    agentTeachingCleanupRetryMutation,
  } = useRpcDependencies();
  const verify = useAtomSet(agentTeachingFlowVerifyMutation, {
    mode: "promise",
  });
  const reject = useAtomSet(agentTeachingFlowRejectMutation, {
    mode: "promise",
  });
  const retryCleanup = useAtomSet(agentTeachingCleanupRetryMutation, {
    mode: "promise",
  });
  const [pending, setPending] = useState(false);
  const [decisionError, setError] = useState<string>();

  const atom = recordingViewAtom(recordingId)(sessionId);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const decide = async (decision: "verify" | "reject" | "retry-cleanup") => {
    if (pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    const save = {
      reject,
      "retry-cleanup": retryCleanup,
      verify,
    }[decision];
    try {
      await save({
        payload: {
          operationId: OperationId.make(globalThis.crypto.randomUUID()),
          recordingId,
        },
      });
      refresh();
    } catch (error) {
      setError(
        failureMessage(
          error,
          decision === "retry-cleanup"
            ? "Cleanup could not be retried."
            : "The decision could not be saved."
        )
      );
      refresh();
    } finally {
      setPending(false);
    }
  };
  if (result._tag === "Initial") {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading Dry Run Summary…
      </p>
    );
  }
  if (result._tag === "Failure") {
    return (
      <p className="text-destructive text-sm" role="alert">
        The Dry Run Summary could not be opened.
      </p>
    );
  }
  const view = result.value;
  let summary = (
    <p className="text-muted-foreground text-sm">
      No retained Dry Run Summary.
    </p>
  );
  if (view.summary !== null) {
    summary = (
      <RunSummaryView
        summary={view.summary}
        videoSrc={dryRunVideoPath(recordingId)}
      />
    );
    if (isTaskDryRunSummary(view.summary) && view.result !== null) {
      summary = (
        <DryRunSummaryView
          result={view.result}
          summary={view.summary}
          videoSrc={dryRunVideoPath(recordingId)}
        />
      );
    }
  }
  const outcome = view.result?.outcome;
  const flowName =
    view.summary !== null && isTaskDryRunSummary(view.summary)
      ? view.summary.purpose.flowName
      : undefined;
  const flow =
    flowName === undefined ? (
      "this Flow"
    ) : (
      <span className="font-mono">{flowName}</span>
    );
  const asks = view.decision === "pending" && outcome === "passed";
  const cleanupKept =
    view.decision === "verified" && view.cleanup._tag === "purge-pending";
  let tone: FlowDecisionTone = "ask";
  if (cleanupKept) {
    tone = "failed";
  } else if (view.decision === "verified") {
    tone = "passed";
  } else if (view.decision === "rejected") {
    tone = "neutral";
  } else if (outcome === "failed") {
    tone = "failed";
  }
  return (
    <section aria-label="Dry Run Summary" className="flex flex-1 flex-col">
      <div className="flex-1">{summary}</div>
      <FlowDecision
        actions={
          <>
            {asks ? (
              <FlowDecisionButtons
                onReject={() => {
                  void decide("reject");
                }}
                onVerify={() => {
                  void decide("verify");
                }}
                pending={pending}
              />
            ) : null}
            {cleanupKept ? (
              <Button
                size="md"
                className="w-full rounded-[10px] text-[13px]"
                disabled={pending}
                onClick={() => {
                  void decide("retry-cleanup");
                }}
                type="button"
                variant="outline"
              >
                Retry cleanup
              </Button>
            ) : null}
          </>
        }
        error={decisionError}
        tone={tone}
      >
        {decisionSentence(view.decision, outcome, flow, view.cleanup)}
      </FlowDecision>
    </section>
  );
};
