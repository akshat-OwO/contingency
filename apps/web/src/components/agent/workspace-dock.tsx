import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The pieces every Workspace dock is made of. Teaching, a Dry Run, an
 * Interactive Run, and the empty canvas all render the same floating card over
 * the same full-bleed browser, so the shell lives here rather than inside the
 * activity that happened to need it first (#209).
 */

export const Wordmark = () => (
  <span className="shrink-0 text-base font-semibold tracking-tight">
    Contingency
  </span>
);

/**
 * A session label reads `Flow Skill · Activity`, or the bare Flow Skill name
 * while teaching. The name is what a person picks by, so it leads; the
 * activity is a quiet second column that still tells two sessions of one Flow
 * Skill apart. The option's accessible name is the whole label.
 */
const SessionOption = ({ label }: { readonly label: string }) => {
  const separator = label.lastIndexOf(" · ");
  if (separator === -1) {
    return <span className="truncate">{label}</span>;
  }
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-3">
      <span className="truncate">{label.slice(0, separator)}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {label.slice(separator + 3)}
      </span>
    </span>
  );
};

/** Deletion stays in the session picker and never selects the deleted row. */
export interface SessionDeletion {
  readonly onDelete: (sessionId: AgentSessionId) => void;
  readonly pending: boolean;
  readonly error: string | undefined;
}

/** A dialog popup allows selection and deletion to be separate keyboard targets. */
export const DockSessionSelect = ({
  className,
  deletion,
  onSelect,
  selectedSessionId,
  sessions,
}: {
  readonly className?: string;
  readonly deletion?: SessionDeletion | undefined;
  readonly onSelect: (sessionId: string) => void;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
}) => {
  const [open, setOpen] = useState(false);
  const selected = sessions.find(({ id }) => id === selectedSessionId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Agent Session"
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        render={
          <Button
            variant="outline"
            className={cn("max-w-56 min-w-0 shrink", className)}
          />
        }
      >
        <span className="truncate">
          {selected === undefined
            ? "Agent Session"
            : agentSessionLabel(selected).split(" · ").at(0)}
        </span>
        <ChevronDownIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Agent Sessions"
        align="start"
        side="top"
        className="w-96 max-w-[calc(100vw-2rem)] gap-1 p-1"
      >
        <PopoverTitle className="text-muted-foreground px-1.5 py-1 text-xs">
          Agent Sessions
        </PopoverTitle>
        <div className="max-h-72 overflow-y-auto">
          {sessions.map((session) => {
            const label = agentSessionLabel(session);
            return (
              <div key={session.id} className="flex items-center gap-1">
                <Button
                  aria-label={label}
                  aria-pressed={session.id === selectedSessionId}
                  className="min-w-0 flex-1 justify-start px-1.5 font-normal"
                  onClick={() => {
                    onSelect(session.id);
                    setOpen(false);
                  }}
                  variant="ghost"
                >
                  <SessionOption label={label} />
                  {session.id === selectedSessionId ? (
                    <CheckIcon aria-hidden="true" />
                  ) : null}
                </Button>
                {deletion === undefined ? null : (
                  <Button
                    aria-label={`Delete session ${label}`}
                    title={`Delete session ${label}`}
                    size="icon-sm"
                    variant="ghost"
                    disabled={deletion.pending}
                    onClick={() => deletion.onDelete(session.id)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {deletion?.error === undefined ? null : (
          <p role="alert" className="text-destructive px-1.5 py-1 text-xs">
            {deletion.error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
};

/**
 * The dock shell: one floating card over a full-bleed browser, in up to three
 * tiers. What the agent is waiting on comes first, then where the session is,
 * then the controls. The controls are one row that never wraps; anything long
 * lives in the tiers above it, which clamp and expand on their own.
 *
 * The dock sits inside the browser stage, which the devtools inspector and the
 * Dry Run Summary narrow independently of the window. So it sizes itself with
 * container queries on the stage rather than viewport breakpoints: at 1440px
 * with devtools docked right the stage is about 800px, and with the summary
 * open too it is about 360px.
 */
export const DockShell = ({
  children,
  footer,
  requests,
  status,
}: {
  /** The controls row: wordmark, session picker, and the actions. */
  readonly children: React.ReactNode;
  /** A refusal under the controls, on its own line. */
  readonly footer?: React.ReactNode;
  /** What the agent is waiting on, or nothing. */
  readonly requests?: React.ReactNode;
  readonly status: React.ReactNode;
}) => (
  <div className="@container pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
    <section
      aria-label="Workspace dock"
      className="bg-background pointer-events-auto w-full max-w-3xl overflow-hidden rounded-xl border shadow-lg"
    >
      {requests}
      {status}
      <div className="flex min-w-0 items-center gap-1.5 border-t px-2 py-1.5">
        {children}
      </div>
      {footer}
    </section>
  </div>
);

/** A spacer that pushes the actions to the end of the controls row. */
export const DockSpacer = () => <div className="min-w-2 flex-1" />;

/** The wordmark gives way first when the stage narrows. */
export const DockWordmark = () => (
  <span className="hidden pl-1 @2xl:inline">
    <Wordmark />
  </span>
);

/**
 * What the dock has to say above the browser rather than inside the card: a
 * refused gesture, a capture failure, a stream failure. What the agent is
 * waiting on is not here; it is the dock's own first tier.
 */
export const DockNotices = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
    <div className="pointer-events-auto max-h-[60svh] w-full max-w-5xl space-y-2 overflow-y-auto">
      {children}
    </div>
  </div>
);

/**
 * Whether a clamped line hides text. The expand control only shows when
 * there is something to expand, and the observer follows the stage as the
 * devtools or the summary change its width.
 */
const useClamped = <Element extends HTMLElement>() => {
  const ref = useRef<Element>(null);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = () => {
      setClamped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, clamped] as const;
};

/**
 * The dock's status tier: the state badges and one line saying where the
 * session is and what happens next. The line is clamped to one row and
 * expands in place, with `details` (the Agent Step, the task) under it.
 *
 * The badges keep a floor under the sentence: when they leave it less than
 * about 12rem, the sentence drops onto its own line rather than ellipsizing
 * after two words (#238).
 *
 * One polite region, changed only when the state changes.
 */
export const DockStatus = ({
  badges,
  children,
  details,
}: {
  readonly badges: React.ReactNode;
  readonly children: React.ReactNode;
  readonly details?: React.ReactNode;
}) => {
  const [expandedAtom] = useState(() => Atom.make(false));
  const [expanded, setExpanded] = useAtom(expandedAtom);
  const [sentenceRef, clamped] = useClamped<HTMLOutputElement>();
  const expandable = clamped || expanded || details !== undefined;
  return (
    <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
        <div className="flex shrink-0 items-center gap-1.5 pt-px">{badges}</div>
        <div className="min-w-48 flex-1">
          <output
            aria-live="polite"
            className={cn(
              "text-muted-foreground block text-xs leading-5 text-pretty wrap-anywhere",
              expanded ? "max-h-40 overflow-y-auto" : "line-clamp-1"
            )}
            ref={sentenceRef}
          >
            {children}
          </output>
          {expanded && details !== undefined ? (
            <div className="mt-2 max-h-56 space-y-3 overflow-y-auto border-t pt-2">
              {details}
            </div>
          ) : null}
        </div>
      </div>
      {expandable ? (
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? "Hide details" : "Show details"}
          className="-mt-0.5 -mr-1"
          onClick={() => setExpanded((current) => !current)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </Button>
      ) : null}
    </div>
  );
};
