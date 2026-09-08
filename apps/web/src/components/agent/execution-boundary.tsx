import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";

import { refusal } from "@/components/agent/draft-review-state";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

export const ExecutionBoundary = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { agentBoundaryResolveMutation } = useRpcDependencies();
  const [result, resolve] = useAtom(agentBoundaryResolveMutation);
  const { boundary } = session;
  if (boundary === undefined || boundary === null) {
    return null;
  }
  const failure = refusal(result);
  const decide = (decision: "allow" | "refuse") => () =>
    resolve({
      payload: {
        data: {
          boundaryId: boundary.id,
          decision,
          operationId: OperationId.make(crypto.randomUUID()),
          sessionId: session.id,
        },
        type: "agent.boundary.resolve",
      },
    });
  return (
    <section
      aria-label="Execution Boundary"
      className="space-y-3 rounded-lg border p-3 text-sm"
    >
      <h2 className="font-semibold">Waiting for confirmation</h2>
      <p>Reason: {boundary.reason}</p>
      <p className="break-words">Requested: {boundary.requested}</p>
      <p>{boundary.description}</p>
      <p className="break-words">Action attempt: {boundary.operationId}</p>
      <pre className="overflow-auto text-xs">
        {JSON.stringify(boundary.action, null, 2)}
      </pre>
      <p>
        {boundary.reason === "domain"
          ? "Allow this exact host for this Run. The saved Domain Scope stays unchanged."
          : "Confirmation permits this exact action attempt once. A retry with a new operation id needs another confirmation."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            session.controller === "user" || session.phase === "takeover"
          }
          onClick={decide("allow")}
        >
          {boundary.reason === "domain"
            ? "Allow host for this Run"
            : "Confirm this attempt"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={decide("refuse")}
        >
          Refuse request
        </Button>
      </div>
      <p>
        Take control remains available. Return control before confirming an
        agent attempt.
      </p>
      {failure === undefined ? null : <p role="alert">{failure}</p>}
    </section>
  );
};
