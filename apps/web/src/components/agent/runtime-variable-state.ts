import type { AgentSessionSnapshot } from "@contingency/protocol";

export const hasRuntimeVariableNotice = (session: AgentSessionSnapshot) =>
  (session.pendingDecisions ?? []).some(
    (decision) => decision.kind === "supply_variable"
  ) ||
  (session.dryRun?.flowSkillName !== undefined &&
    session.run !== null &&
    "schemaVersion" in session.run &&
    session.run.variables.some(
      (variable) => variable.lastAnswer !== undefined
    ));
