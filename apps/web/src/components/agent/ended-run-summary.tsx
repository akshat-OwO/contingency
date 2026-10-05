import type { AgentRunId } from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

import { InteractiveRunSummaryView } from "@/components/agent/dry-run-summary";
import { isTaskInteractiveRunSummary } from "@/components/agent/dry-run-summary-state";
import { RunSummaryView } from "@/components/agent/run-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

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
          {refusal(result) ??
            "No persisted Run Summary was found under the selected Catalog Root."}
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
