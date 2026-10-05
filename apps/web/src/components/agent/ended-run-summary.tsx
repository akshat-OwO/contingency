import type { AgentRunId } from "@contingency/protocol";
import { isBrowserRpcError } from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

import { InteractiveRunSummaryView } from "@/components/agent/dry-run-summary";
import { isTaskInteractiveRunSummary } from "@/components/agent/dry-run-summary-state";
import { RunSummaryView } from "@/components/agent/run-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

/**
 * Why the docked Summary is missing. Only a Summary that never arrived
 * after the Run ended reads as unwritten; any other refusal is its own
 * sentence.
 */
const missingSummaryMessage = (cause: Cause.Cause<unknown>): string | null => {
  const failure = Cause.squash(cause);
  return isBrowserRpcError(failure) && failure.code === "agent_run_not_found"
    ? "The Run ended, but its Run Summary was not written in time. Open it later with open_run."
    : null;
};

/**
 * The Run Summary docked beside an Interactive Run the Workspace watched end.
 * A task Run reads like a Dry Run's summary; a historical Step record keeps
 * the view it was persisted for.
 */
export const EndedRunSummary = ({ runId }: { readonly runId: AgentRunId }) => {
  const { endedRunSummaryAtom } = useRpcDependencies();
  const result = useAtomValue(endedRunSummaryAtom(runId));
  if (result._tag === "Initial") {
    return (
      <p
        aria-live="polite"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
        Writing the Run Summary…
      </p>
    );
  }
  if (result._tag === "Failure") {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>The Run Summary could not be opened</AlertTitle>
        <AlertDescription>
          {missingSummaryMessage(result.cause) ??
            refusal(result) ??
            "The server refused to read this Run Summary."}
        </AlertDescription>
      </Alert>
    );
  }
  const { summary } = result.value;
  return isTaskInteractiveRunSummary(summary) ? (
    <InteractiveRunSummaryView summary={summary} />
  ) : (
    <RunSummaryView summary={summary} />
  );
};
