import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomMount } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronUpIcon,
  KeyRoundIcon,
  MinusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Activity, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { requestIconClassName } from "./dock-request-parts";
import {
  dockRequests,
  emptyTakeoverForm,
  requestQueue,
  setAsideAfter,
  staysCollapsed,
  takeoverKey,
} from "./dock-requests-state";
import type { DockRequest, TakeoverForm } from "./dock-requests-state";
import { DryRunVariables } from "./dry-run-variables";
import { ExecutionBoundary } from "./execution-boundary";
import { GuidedRunQuestions } from "./guided-run-questions";
import { GuidedTakeoverVariable } from "./guided-takeover-variable";
import { RuntimeVariables } from "./runtime-variables";
import { SetupVariables } from "./setup-variables";

/** A title as a sentence: a question keeps its mark, anything else ends. */
const sentence = (title: string) =>
  /[.?!]$/u.test(title) ? title : `${title}.`;

/**
 * The one line a collapsed island keeps: the request it shows, and how to
 * reopen it. The whole line is the control, so it is easy to hit at the
 * bottom edge of a narrow stage.
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
      aria-label={`Show request: ${sentence(first.title)} ${first.summary}`}
      className="hover:bg-muted/70 focus-visible:ring-ring flex h-10 w-full min-w-0 items-center gap-2 px-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
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
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          +{rest.length} more
        </span>
      )}
      <ChevronUpIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
    </button>
  );
};

/**
 * Whether the island's content runs past its bottom edge, so the island can
 * show that it scrolls. It measures again when the island scrolls, when a
 * request grows or shrinks, and when the shown request changes.
 */
const useRunsPastBottom = () => {
  const [pastAtom] = useState(() => Atom.make(false));
  const [past, setPast] = useAtom(pastAtom);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (node === null) {
      return;
    }
    const measure = () =>
      setPast(node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    measure();
    const resizes = new ResizeObserver(measure);
    resizes.observe(node);
    // Showing another request, or a field's message, changes the height
    // without resizing the island once it is at its cap.
    const mutations = new MutationObserver(measure);
    mutations.observe(node, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      resizes.disconnect();
      mutations.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [node, setPast]);
  return [past, setNode] as const;
};

/**
 * What the agent is waiting on the user for, in the **Requests** island at
 * the bottom left of the stage (#753): a paused Execution Boundary, requests
 * for private inputs, and a Guided Run's questions. The island floats over
 * the page or device, so a request coming or going never resizes the stage.
 *
 * It shows one request at a time. When more wait, "+N more after this" sets
 * the shown one aside and shows the next, so every request stays reachable
 * and the queue comes back round. Requests set aside stay mounted but hidden,
 * so a half-typed value survives stepping past it.
 *
 * The island collapses to one line so a long request never has to cover the
 * page the person is reading to answer it. Collapsing hides the requests on
 * screen at that moment; a new one opens the island again. A request taller
 * than the room above the dock scrolls, and fades at the bottom edge while
 * more of it is below.
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
  const [setAsideAtom] = useState(() => Atom.make<readonly string[]>([]));
  const [setAside, setSetAside] = useAtom(setAsideAtom);
  const [runsPastBottom, scrollRef] = useRunsPastBottom();
  // The island stays mounted while collapsed, so it keeps the Takeover
  // Variable's draft and Entered list across a fold. Each Takeover gets its
  // own form: returning control lets the old one go.
  const [takeoverForms] = useState(() =>
    Atom.family((_takeover: string) =>
      Atom.make<TakeoverForm>(emptyTakeoverForm)
    )
  );
  const takeoverAtom = takeoverForms(takeoverKey(session));
  // Mounted here, the atom outlives the card: an unsubscribed atom resets.
  useAtomMount(takeoverAtom);
  const requests = dockRequests(session);
  const queue = requestQueue(requests, setAside);
  const [shown, next] = queue;
  if (shown === undefined) {
    return null;
  }
  if (staysCollapsed(requests, collapsedKeys)) {
    return (
      <div className="border-b">
        <CollapsedRequests
          onExpand={() => setCollapsedKeys(new Set<string>())}
          requests={queue}
        />
      </div>
    );
  }
  const collapse = (
    <Button
      aria-expanded
      aria-label="Collapse requests"
      // A bare minus, as the prototype's small icon button: no tile, even
      // though it reports the island as expanded.
      className="aria-expanded:text-muted-foreground aria-expanded:hover:bg-island-hover aria-expanded:hover:text-foreground size-[26px] rounded-lg aria-expanded:bg-transparent"
      onClick={() => setCollapsedKeys(new Set(requests.map(({ key }) => key)))}
      size="icon-xs"
      title="Collapse requests"
      type="button"
      variant="island"
    >
      <MinusIcon className="size-4" />
    </Button>
  );
  const visible = (kind: DockRequest["kind"]) =>
    shown.kind === kind ? "visible" : "hidden";
  const secrets =
    session.activity === "run" ? (session.dryRun?.variables ?? []) : [];
  const more = queue.length - 1;
  return (
    <div
      className={cn(
        "grid max-h-[min(60svh,36rem)] scroll-pb-8 gap-3 overflow-y-auto overscroll-contain border-b p-3.5",
        runsPastBottom &&
          "[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_2rem),transparent)]"
      )}
      ref={scrollRef}
    >
      <Activity mode={visible("guided-run-questions")}>
        <GuidedRunQuestions collapse={collapse} session={session} />
      </Activity>
      <Activity mode={visible("boundary")}>
        <ExecutionBoundary
          key={session.boundary?.id}
          collapse={collapse}
          queued={queue.length}
          session={session}
        />
      </Activity>
      <Activity mode={visible("setup-variables")}>
        <SetupVariables collapse={collapse} session={session} />
      </Activity>
      <Activity mode={visible("runtime-variables")}>
        <RuntimeVariables collapse={collapse} session={session} />
      </Activity>
      <Activity mode={visible("dry-run-secrets")}>
        <DryRunVariables
          collapse={collapse}
          sessionId={session.id}
          variables={secrets}
        />
      </Activity>
      <Activity mode={visible("takeover-variable")}>
        <GuidedTakeoverVariable
          collapse={collapse}
          session={session}
          stateAtom={takeoverAtom}
        />
      </Activity>
      {next === undefined ? null : (
        <Button
          aria-label={`+${more} more after this. Show ${next.title}`}
          className="text-muted-foreground hover:text-foreground ml-11 h-auto justify-self-start p-0 font-mono text-xs font-normal"
          onClick={() => setSetAside(setAsideAfter(requests, setAside, shown))}
          title={`Show ${next.title}`}
          type="button"
          variant="link"
        >
          +{more} more after this
        </Button>
      )}
    </div>
  );
};
