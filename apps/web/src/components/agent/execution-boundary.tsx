import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";
import { RequestHeader, requestIconClassName } from "./dock-request-parts";
import { boundaryTitle } from "./dock-requests-state";

const domainApprovalSummary = (session: AgentSessionSnapshot): string =>
  session.activity === "teaching" && session.origin === "guided-run"
    ? "Allowing this exact host adds it to this Guided Run and the saved Flow's Domain Scope."
    : "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged.";

/** What Allow grants for this boundary, or why it cannot be given now. */
const boundaryScope = (session: AgentSessionSnapshot, reason: string) => {
  if (session.controller === "user") {
    return "You hold the browser, so this can only be refused now. Return control to allow it.";
  }
  return reason === "domain"
    ? domainApprovalSummary(session)
    : "Allow permits this exact attempt once; a retry asks again.";
};

/** The user resolves the exact pending boundary in the Workspace dock. */
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
  const { agentBoundaryDecisionMutation } = useRpcDependencies();
  const answer = useAtomSet(agentBoundaryDecisionMutation, { mode: "promise" });
  const [stateAtom] = useState(() =>
    Atom.make({ answered: false, error: "", pending: false })
  );
  const [state, setState] = useAtom(stateAtom);
  const [operations] = useState(() => ({
    allow: OperationId.make(crypto.randomUUID()),
    refuse: OperationId.make(crypto.randomUUID()),
  }));
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
  const submit = async (decision: "allow" | "refuse") => {
    if (pending === undefined || state.pending || state.answered) {
      return;
    }
    setState({ answered: false, error: "", pending: true });
    try {
      await answer({
        payload: {
          decision,
          operationId: operations[decision],
          pendingDecisionId: pending.pendingDecisionId,
          sessionId: session.id,
        },
      });
      setState({ answered: true, error: "", pending: false });
    } catch (error) {
      setState({
        answered: false,
        error: failureMessage(
          error,
          "Could not answer this request. Reread the session before retrying."
        ),
        pending: false,
      });
    }
  };
  const scope = boundaryScope(session, boundary.reason);
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
      {/*
        While the person holds the browser the constraint is the news: Allow
        is off until they return control, so it leads.
      */}
      {session.controller === "user" ? (
        <p className="text-xs font-medium text-pretty">{scope}</p>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {/*
            The concrete action leads: it is what Allow permits. What was
            requested (the task, or the address asked for) follows, and only
            when the action does not already say it ("Navigate to <url>").
          */}
          <p className="text-sm text-pretty wrap-anywhere">
            {boundary.description}
          </p>
          {boundary.description.includes(boundary.requested) ? null : (
            <p className="text-muted-foreground text-xs text-pretty wrap-anywhere">
              {boundary.requested}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button
            disabled={
              pending === undefined ||
              session.controller !== "agent" ||
              state.pending ||
              state.answered
            }
            onClick={async () => {
              await submit("allow");
            }}
            size="sm"
            type="button"
          >
            Allow
          </Button>
          <Button
            disabled={pending === undefined || state.pending || state.answered}
            onClick={async () => {
              await submit("refuse");
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Refuse
          </Button>
        </div>
      </div>
      {state.pending || state.answered ? (
        <p role="status" className="text-muted-foreground text-xs">
          {state.pending ? "Saving decision…" : "Decision saved"}
        </p>
      ) : null}
      {open ? (
        <div className="bg-background space-y-2 rounded-lg border p-2.5 text-xs">
          <p className="wrap-anywhere">
            <span className="text-muted-foreground">Action attempt </span>
            <code className="font-mono">{boundary.operationId}</code>
          </p>
          <pre className="bg-muted/60 max-h-28 overflow-auto rounded-md p-2 font-mono">
            {JSON.stringify(boundary.action, null, 2)}
          </pre>
        </div>
      ) : null}
      {/*
        What Allow grants is part of the decision, so it stays visible beside
        the buttons; only the attempt id and its payload wait behind details.
      */}
      {session.controller === "user" ? null : (
        <p className="text-muted-foreground text-xs text-pretty">{scope}</p>
      )}
      {state.error === "" ? null : (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}
    </section>
  );
};
