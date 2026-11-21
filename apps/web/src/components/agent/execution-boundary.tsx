import { OperationId } from "@contingency/protocol";
import type {
  AgentExecutionBoundary,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon, ShieldAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";
import {
  RequestHeader,
  RequestNote,
  requestIconClassName,
} from "./dock-request-parts";
import { boundaryTitle } from "./dock-requests-state";

const domainApprovalSummary = (session: AgentSessionSnapshot): string =>
  session.activity === "teaching" && session.origin === "guided-run"
    ? "Allowing this exact host adds it to this Guided Run and the saved Flow's Domain Scope."
    : "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged.";

/** What Allow grants for this boundary. */
const boundaryScope = (
  session: AgentSessionSnapshot,
  reason: AgentExecutionBoundary["reason"]
) =>
  reason === "domain"
    ? domainApprovalSummary(session)
    : "Allow permits this exact attempt once; a retry asks again.";

/**
 * What the boundary would let through, for its target pill, and what was
 * asked for when the target does not already say it. A new host shows the
 * address it would visit; any other boundary shows the concrete action, with
 * the task or address it serves above it.
 */
const boundaryTarget = (boundary: AgentExecutionBoundary) => {
  const [target, context] =
    boundary.reason === "domain"
      ? [boundary.requested, boundary.description]
      : [boundary.description, boundary.requested];
  return {
    // "Navigate to <url>" already says what was requested.
    context: boundary.description.includes(boundary.requested)
      ? undefined
      : context,
    target,
  };
};

/**
 * Soft break points in an address or action, so a long one wraps after a
 * slash, query separator or fragment, or before a dot, never inside a word.
 * The `//` after a scheme and a decimal such as `$74.00` stay whole.
 */
const BREAK_POINTS = /(?<=[/?#&=])(?!\/)|(?=\.(?!\d))/u;

const Breakable = ({ text }: { readonly text: string }) => {
  const parts = text.split(BREAK_POINTS);
  let offset = 0;
  return parts.map((part, index) => {
    const at = offset;
    offset += part.length;
    return index === 0 ? (
      part
    ) : (
      <span key={at}>
        <wbr />
        {part}
      </span>
    );
  });
};

type ActionLine = readonly [term: string, detail: string];

/** An optional element ref, as a line when the action names one. */
const refLine = (ref: string | null | undefined): readonly ActionLine[] =>
  ref === null || ref === undefined ? [] : [["Element", ref]];

/** Each field of the attempt's action, under a name a person reads. */
const actionFields = (
  action: AgentExecutionBoundary["action"]
): readonly ActionLine[] => {
  switch (action.type) {
    case "android":
    case "ios":
    case "history": {
      return [["Action", action.action]];
    }
    case "navigate": {
      return [["URL", action.url]];
    }
    case "click":
    case "hover": {
      return refLine(action.ref);
    }
    case "fill": {
      return [...refLine(action.ref), ["Text", action.text]];
    }
    case "select": {
      return [...refLine(action.ref), ["Values", action.values.join(", ")]];
    }
    case "press": {
      return [["Key", action.key], ...refLine(action.ref)];
    }
    case "scroll": {
      return [
        ...refLine(action.ref),
        ["Scroll", `${action.deltaX}, ${action.deltaY}`],
      ];
    }
    case "wait_for_text": {
      return [
        ["Text", action.text],
        ...(action.timeoutMs === null || action.timeoutMs === undefined
          ? []
          : [["Timeout", `${action.timeoutMs} ms`] as const]),
      ];
    }
    case "eval": {
      return [
        ["Tab", action.tabId],
        ["Script", action.script],
      ];
    }
    case "upload": {
      return [
        ...refLine(action.ref),
        ["Tab", action.tabId],
        ["Files", action.files.join(", ")],
      ];
    }
    default: {
      return action satisfies never;
    }
  }
};

/**
 * The attempt behind a boundary, behind **Action details**, as a short list
 * rather than its JSON (#776): the attempt id a person may match in the agent
 * conversation, the kind of action, and each of its fields.
 */
const ActionDetailsList = ({
  boundary,
  id,
}: {
  readonly boundary: AgentExecutionBoundary;
  readonly id: string;
}) => {
  const lines: readonly ActionLine[] = [
    ["Attempt", boundary.operationId],
    ["Type", boundary.action.type],
    ...actionFields(boundary.action),
  ];
  return (
    <dl className="grid gap-[3px] px-3 text-[12.5px]" id={id}>
      {lines.map(([term, detail]) => (
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2" key={term}>
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="font-mono wrap-anywhere whitespace-pre-wrap">
            {detail}
          </dd>
        </div>
      ))}
    </dl>
  );
};

/**
 * The **Action details** disclosure: a chevron and its label at the start of
 * the decision row, across from Refuse and Allow. Its list opens under the
 * target.
 */
const ActionDetailsToggle = ({
  controls,
  onToggle,
  open,
}: {
  readonly controls: string;
  readonly onToggle: () => void;
  readonly open: boolean;
}) => (
  <Button
    aria-controls={open ? controls : undefined}
    aria-expanded={open}
    className="text-muted-foreground hover:text-foreground mr-auto -ml-1.5 gap-1 px-1.5 text-xs"
    onClick={onToggle}
    size="xs"
    type="button"
  >
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "transition-transform duration-200 motion-reduce:transition-none",
        open && "rotate-90"
      )}
    />
    {open ? "Hide action details" : "Action details"}
  </Button>
);

/** The eyebrow over a boundary's question, with its place in the queue. */
const BoundaryEyebrow = ({ queued }: { readonly queued: number }) => (
  <>
    Execution Boundary
    {queued > 1 ? (
      <span className="text-muted-foreground font-mono font-medium">
        {" "}
        · 1 of {queued}
      </span>
    ) : null}
  </>
);

/**
 * The user resolves the exact pending boundary in the Requests island, as
 * the prototype's boundary card (#753): the eyebrow and question, what Allow
 * grants, the target, then **Refuse** and **Allow** at the bottom right.
 */
export const ExecutionBoundary = ({
  collapse,
  queued = 1,
  session,
}: {
  /** The island's collapse control. */
  readonly collapse?: React.ReactNode;
  /** How many requests the island holds, this one first. */
  readonly queued?: number;
  readonly session: AgentSessionSnapshot;
}) => {
  const { agentBoundaryDecisionMutation } = useRpcDependencies();
  const answer = useAtomSet(agentBoundaryDecisionMutation, { mode: "promise" });
  const [stateAtom] = useState(() =>
    Atom.make({ answered: false, error: "", pending: false })
  );
  const [state, setState] = useAtom(stateAtom);
  const [detailsAtom] = useState(() => Atom.make(false));
  const [detailsOpen, setDetailsOpen] = useAtom(detailsAtom);
  const detailsId = useId();
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
  const { context, target } = boundaryTarget(boundary);
  const userHolds = session.controller === "user";
  return (
    <section aria-label="Execution Boundary" className="grid gap-3">
      <RequestHeader
        action={collapse}
        badge={<BoundaryEyebrow queued={queued} />}
        icon={
          <ShieldAlertIcon
            aria-hidden="true"
            className={requestIconClassName}
          />
        }
        title={boundaryTitle[boundary.reason]}
      />
      <div className="-mt-0.5 grid gap-0.5">
        {context === undefined ? null : (
          <p className="text-[12.5px] text-pretty wrap-break-word">{context}</p>
        )}
        <RequestNote>{boundaryScope(session, boundary.reason)}</RequestNote>
      </div>
      <p className="bg-island-hover rounded-xl px-3 py-[9px] font-mono text-[12.5px] wrap-break-word whitespace-pre-wrap">
        <Breakable text={target} />
      </p>
      {detailsOpen ? (
        <ActionDetailsList boundary={boundary} id={detailsId} />
      ) : null}
      {/*
        While the person holds the browser, Allow is off until they return
        control (ADR 0052), so the card says why above the buttons.
      */}
      {userHolds ? (
        <p className="text-muted-foreground text-xs text-pretty">
          Return control to allow. You can still refuse.
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <ActionDetailsToggle
          controls={detailsId}
          onToggle={() => setDetailsOpen((current) => !current)}
          open={detailsOpen}
        />
        <Button
          className="bg-island-hover text-foreground shadow-[inset_0_0_0_1px_var(--island-border)]"
          disabled={pending === undefined || state.pending || state.answered}
          onClick={async () => {
            await submit("refuse");
          }}
          size="island-lg"
          type="button"
        >
          Refuse
        </Button>
        <Button
          variant="primary"
          disabled={
            pending === undefined ||
            session.controller !== "agent" ||
            state.pending ||
            state.answered
          }
          onClick={async () => {
            await submit("allow");
          }}
          size="island-lg"
          type="button"
        >
          Allow
        </Button>
      </div>
      {state.pending || state.answered ? (
        <p role="status" className="text-muted-foreground text-xs">
          {state.pending ? "Saving decision…" : "Decision saved"}
        </p>
      ) : null}
      {state.error === "" ? null : (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}
    </section>
  );
};
