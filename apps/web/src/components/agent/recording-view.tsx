import { OperationId, dryRunVideoPath } from "@contingency/protocol";
import type { TeachingRecordingId } from "@contingency/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { DryRunSummaryView } from "@/components/agent/dry-run-summary";
import { isTaskDryRunSummary } from "@/components/agent/dry-run-summary-state";
import { RunSummaryView } from "@/components/agent/run-view";
import { Button } from "@/components/ui/button";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const decisions = {
  pending: "Awaiting the user's Verify / Reject decision.",
  rejected: "The user rejected this Flow.",
  verified:
    "The user verified this Flow. Cleanup removes its recording evidence.",
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
  } = useRpcDependencies();
  const verify = useAtomSet(agentTeachingFlowVerifyMutation, {
    mode: "promise",
  });
  const reject = useAtomSet(agentTeachingFlowRejectMutation, {
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
  const decide = async (decision: "verify" | "reject") => {
    if (pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await (decision === "verify" ? verify : reject)({
        payload: {
          operationId: OperationId.make(globalThis.crypto.randomUUID()),
          recordingId,
        },
      });
      refresh();
    } catch (error) {
      setError(failureMessage(error, "The decision could not be saved."));
      refresh();
    } finally {
      setPending(false);
    }
  };
  if (result._tag === "Initial") {
    return <p role="status">Loading Dry Run Summary…</p>;
  }
  if (result._tag === "Failure") {
    return <p role="alert">The Dry Run Summary could not be opened.</p>;
  }
  const view = result.value;
  let summary = <p>No retained Dry Run Summary.</p>;
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
  return (
    <section aria-label="Dry Run Summary" className="space-y-4 p-4">
      <p role="status">
        {view.decision === "pending" && view.result?.outcome === "failed"
          ? "This Flow cannot be verified until a Dry Run passes. The agent needs to fix it and run another Dry Run."
          : decisions[view.decision]}
      </p>
      {view.decision === "pending" && view.result?.outcome === "passed" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() => {
              void decide("verify");
            }}
            type="button"
          >
            Verify flow
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              void decide("reject");
            }}
            type="button"
            variant="outline"
          >
            Reject flow
          </Button>
        </div>
      ) : null}
      {decisionError === undefined ? null : <p role="alert">{decisionError}</p>}
      {summary}
    </section>
  );
};
