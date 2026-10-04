import type { AgentSessionSnapshot } from "@contingency/protocol";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";

/**
 * The paused Execution Boundary, as a read-only mirror. The user allows or
 * refuses it by answering the pending decision in the agent conversation
 * ([ADR 0037](../../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)).
 */
export const ExecutionBoundary = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { boundary } = session;
  if (
    !hasExecutionBoundaryNotice(session) ||
    boundary === undefined ||
    boundary === null
  ) {
    return null;
  }
  const pending = (session.pendingDecisions ?? []).find(
    (decision) =>
      decision.kind === "boundary" && decision.boundaryId === boundary.id
  );
  return (
    <section
      aria-label="Execution Boundary"
      className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
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
          ? "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged."
          : "Allowing permits this exact action attempt once. A retry with a new operation id needs another decision."}
      </p>
      <p>
        Reply "allow" or "refuse" in your agent conversation. The agent will
        relay your choice to Contingency.
        {pending === undefined ? null : (
          <code className="ml-1 wrap-anywhere">
            {pending.pendingDecisionId}
          </code>
        )}
      </p>
      <p>
        Take control remains available. Return control before allowing an agent
        attempt.
      </p>
    </section>
  );
};
