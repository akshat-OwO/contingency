import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";
import {
  RelayHint,
  RequestHeader,
  requestIconClassName,
} from "./dock-request-parts";
import { boundaryTitle } from "./dock-requests-state";

/**
 * The paused Execution Boundary, as a read-only mirror in the dock's first
 * tier. The user allows or refuses it by answering the pending decision in
 * the agent conversation
 * ([ADR 0037](../../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)),
 * so the dock offers no allow or refuse button, only the request, where to
 * answer it, and the decision id to answer.
 *
 * The action attempt, its JSON, and what allowing covers sit behind
 * `Action details`: they matter when checking a decision, not when reading
 * what is being asked.
 */
export const ExecutionBoundary = ({
  collapse,
  session,
}: {
  /** The tier's collapse control, when this is its first request. */
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => {
  const [openAtom] = useState(() => Atom.make(false));
  const [open, setOpen] = useAtom(openAtom);
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
    <section aria-label="Execution Boundary" className="space-y-1.5">
      <RequestHeader
        action={
          <>
            <Button
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {open ? "Hide action details" : "Action details"}
            </Button>
            {collapse}
          </>
        }
        icon={
          <ShieldAlertIcon
            aria-hidden="true"
            className={requestIconClassName}
          />
        }
        title={boundaryTitle[boundary.reason]}
      />
      <p className="text-sm text-pretty wrap-anywhere">{boundary.requested}</p>
      {/*
        The description often repeats the request word for word; a second
        identical line reads as a rendering bug, so it shows only when it adds
        something.
      */}
      {boundary.description === boundary.requested ? null : (
        <p className="text-muted-foreground text-xs text-pretty wrap-anywhere">
          {boundary.description}
        </p>
      )}
      {open ? (
        <div className="bg-background space-y-2 rounded-lg border p-2.5 text-xs">
          <p className="wrap-anywhere">
            <span className="text-muted-foreground">Action attempt </span>
            <code className="font-mono">{boundary.operationId}</code>
          </p>
          <pre className="bg-muted/60 max-h-28 overflow-auto rounded-md p-2 font-mono">
            {JSON.stringify(boundary.action, null, 2)}
          </pre>
          <p className="text-muted-foreground text-pretty">
            {boundary.reason === "domain"
              ? "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged."
              : "Allowing permits this exact action attempt once. A retry with a new operation id needs another decision."}{" "}
            Take control remains available. Return control before allowing an
            agent attempt.
          </p>
        </div>
      ) : null}
      <RelayHint pendingDecisionId={pending?.pendingDecisionId}>
        Reply <strong className="text-foreground font-medium">allow</strong> or{" "}
        <strong className="text-foreground font-medium">refuse</strong> in your
        agent conversation. The agent relays your choice to Contingency.
      </RelayHint>
    </section>
  );
};
