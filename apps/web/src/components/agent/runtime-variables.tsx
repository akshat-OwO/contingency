import type { AgentSessionSnapshot } from "@contingency/protocol";

import { DryRunPrerequisiteVariables } from "./dry-run-prerequisite-variables";

/** Read-only requests; private values are supplied in the MCP conversation. */
export const RuntimeVariables = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  if (session.dryRun?.flowSkillName !== undefined) {
    return <DryRunPrerequisiteVariables session={session} />;
  }
  const pending = (session.pendingDecisions ?? []).filter(
    (decision) => decision.kind === "supply_variable"
  );
  if (pending.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Runtime Variables"
      className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
    >
      <h2 className="font-semibold">Inputs needed</h2>
      {pending.map((decision) => (
        <div className="space-y-1" key={decision.pendingDecisionId}>
          <p>
            {decision.variable?.flowSkillName === undefined
              ? decision.variable?.name
              : `${decision.variable.flowSkillName}/${decision.variable.name}`}
          </p>
          <p>{decision.scopeSummary}</p>
          <code className="text-xs wrap-anywhere">
            {decision.pendingDecisionId}
          </code>
        </div>
      ))}
      <p>Supply or refuse these inputs in your agent conversation.</p>
    </section>
  );
};
