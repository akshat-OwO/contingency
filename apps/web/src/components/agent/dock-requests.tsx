import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  KeyRoundIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { requestIconClassName } from "./dock-request-parts";
import { dockRequests, staysCollapsed } from "./dock-requests-state";
import type { DockRequest } from "./dock-requests-state";
import { DryRunVariables } from "./dry-run-variables";
import { ExecutionBoundary } from "./execution-boundary";
import { RuntimeVariables } from "./runtime-variables";
import { SetupVariables } from "./setup-variables";

/**
 * The one line a collapsed tier keeps: what is asked, and how to reopen it.
 * The whole line is the control, so it is easy to hit at the bottom edge of
 * a narrow stage.
 */
const CollapsedRequests = ({
  onExpand,
  requests,
}: {
  readonly onExpand: () => void;
  readonly requests: readonly DockRequest[];
}) => {
  const [first, ...rest] = requests;
  if (first === undefined) {
    return null;
  }
  return (
    <button
      aria-expanded={false}
      aria-label={`Show request: ${first.title}. ${first.summary}`}
      className="hover:bg-muted/70 focus-visible:ring-ring/50 flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
      onClick={onExpand}
      type="button"
    >
      {first.kind === "boundary" ? (
        <ShieldAlertIcon aria-hidden="true" className={requestIconClassName} />
      ) : (
        <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
      )}
      <span className="shrink-0 text-sm font-medium">{first.title}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {first.summary}
      </span>
      {rest.length === 0 ? null : (
        <Badge variant="secondary">+{rest.length} more</Badge>
      )}
      <ChevronUpIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
    </button>
  );
};

/**
 * The dock's first tier: what the agent is waiting on the user for. A paused
 * Execution Boundary and requests for private inputs used to float as cards
 * at the top of the stage, away from the dock's state and its one control.
 * Here they sit directly above the status line they explain.
 *
 * The tier collapses to one line so a long request never has to cover the
 * page the person is reading to answer it. Collapsing hides the requests on
 * screen at that moment; a new one opens the tier again. Past about a third
 * of the screen the tier scrolls, so the controls never leave it.
 */
export const DockRequests = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const [collapsedAtom] = useState(() =>
    Atom.make<ReadonlySet<string>>(new Set<string>())
  );
  const [collapsedKeys, setCollapsedKeys] = useAtom(collapsedAtom);
  const requests = dockRequests(session);
  if (requests.length === 0) {
    return null;
  }
  if (staysCollapsed(requests, collapsedKeys)) {
    return (
      <div className="bg-muted/50 border-b">
        <CollapsedRequests
          onExpand={() => setCollapsedKeys(new Set<string>())}
          requests={requests}
        />
      </div>
    );
  }
  const collapse = (
    <Button
      aria-expanded
      aria-label="Collapse requests"
      onClick={() => setCollapsedKeys(new Set(requests.map(({ key }) => key)))}
      size="icon-xs"
      title="Collapse requests"
      type="button"
      variant="ghost"
    >
      <ChevronDownIcon />
    </Button>
  );
  const [first] = requests;
  const collapseFor = (kind: DockRequest["kind"]) =>
    first?.kind === kind ? collapse : null;
  const secrets =
    session.activity === "run" ? (session.dryRun?.variables ?? []) : [];
  return (
    <div className="bg-muted/50 max-h-[min(45svh,22rem)] space-y-3 overflow-y-auto border-b px-3 py-2.5">
      <ExecutionBoundary collapse={collapseFor("boundary")} session={session} />
      <SetupVariables
        collapse={collapseFor("setup-variables")}
        session={session}
      />
      <RuntimeVariables
        collapse={collapseFor("runtime-variables")}
        session={session}
      />
      <DryRunVariables
        collapse={collapseFor("dry-run-secrets")}
        sessionId={session.id}
        variables={secrets}
      />
    </div>
  );
};
