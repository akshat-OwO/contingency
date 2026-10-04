import type { AgentSessionSnapshot } from "@contingency/protocol";
import { KeyRoundIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import {
  RelayHint,
  RequestHeader,
  requestIconClassName,
} from "./dock-request-parts";
import {
  DryRunPrerequisiteVariables,
  ExampleVariables,
} from "./dry-run-prerequisite-variables";
import { takesExampleVariables } from "./run-provenance";

/**
 * Runtime Variable requests. A Dry Run's prerequisites and an Example's
 * private inputs are supplied here; any other Run's are read-only, because
 * their values are supplied in the MCP conversation.
 */
export const RuntimeVariables = ({
  collapse,
  session,
}: {
  /** The tier's collapse control, when this is its first request. */
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => {
  if (session.dryRun?.flowSkillName !== undefined) {
    return (
      <DryRunPrerequisiteVariables collapse={collapse} session={session} />
    );
  }
  if (takesExampleVariables(session)) {
    return <ExampleVariables collapse={collapse} session={session} />;
  }
  const pending = (session.pendingDecisions ?? []).filter(
    (decision) => decision.kind === "supply_variable"
  );
  if (pending.length === 0) {
    return null;
  }
  return (
    <section aria-label="Runtime Variables" className="space-y-2">
      <RequestHeader
        action={collapse}
        badge={<Badge variant="secondary">{pending.length} needed</Badge>}
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title="Inputs needed"
      />
      <ul className="space-y-2">
        {pending.map((decision) => (
          <li className="space-y-1" key={decision.pendingDecisionId}>
            <p className="font-mono text-xs">
              {decision.variable?.flowSkillName === undefined ||
              decision.variable.flowSkillName === null
                ? decision.variable?.name
                : `${decision.variable.flowSkillName}/${decision.variable.name}`}
            </p>
            <p className="text-muted-foreground text-xs">
              {decision.scopeSummary}
            </p>
            <RelayHint pendingDecisionId={decision.pendingDecisionId}>
              Supply or refuse this input in your agent conversation.
            </RelayHint>
          </li>
        ))}
      </ul>
    </section>
  );
};
