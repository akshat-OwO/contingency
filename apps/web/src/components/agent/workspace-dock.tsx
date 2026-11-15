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
  CircleAlertIcon,
  CircleCheckIcon,
  CircleIcon,
  GlobeIcon,
  LoaderCircleIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";
import { WatcherMark } from "@/components/brand";
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

/**
 * A session label reads `Flow · Activity`, or the bare Flow name
 * while teaching. The name is what a person picks by, so it leads; the
 * activity is a quiet second column that still tells two sessions of one
 * Flow apart. The option's accessible name is the whole label.
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

/**
 * Every dock's session picker trigger: quiet, and the first thing to shrink
 * when the actions need the room.
 */
export const dockSessionTriggerClassName =
  "min-w-0 max-w-[min(18rem,55%)] shrink justify-start gap-2 px-2";

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
        // The trigger shows the name's start; hovering shows all of it.
        title={selected === undefined ? undefined : agentSessionLabel(selected)}
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
            variant="ghost"
            size="sm"
            className={cn(dockSessionTriggerClassName, className)}
          />
        }
      >
        <GlobeIcon aria-hidden="true" className="text-muted-foreground" />
        <span className="truncate font-medium">
          {selected === undefined
            ? "Agent Session"
            : agentSessionLabel(selected).split(" · ").at(0)}
        </span>
        <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
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
 * Publishes the height of the dock's deliberate tiers on the stage it floats
 * over as `--dock-height`, so a stage can keep its content clear of the dock
 * however many request tiers it has grown. Transient notices float above the
 * dock outside the measured element, so a refusal appearing or clearing never
 * resizes the stage's content.
 */
const useDockHeight = () => {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const stage = element?.closest(
      '[data-slot="workspace-dock-container"]'
    )?.parentElement;
    if (element === null || stage === null || stage === undefined) {
      return;
    }
    const observer = new ResizeObserver(() => {
      stage.style.setProperty("--dock-height", `${element.offsetHeight}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      stage.style.removeProperty("--dock-height");
    };
  }, [element]);
  return setElement;
};

/**
 * The dock shell: one compact floating card over a full-bleed browser. What
 * the agent is waiting on comes first, as a tier above. Then the status line,
 * then the session picker and the actions. The card stops at 42rem however
 * wide the stage is, so a wide stage gets a centered card rather than a long
 * bar. The state's tone lives in its label and mark, never in an edge.
 *
 * The dock sits inside the browser stage, which the devtools inspector and the
 * Dry Run Summary narrow independently of the window. So it sizes itself with
 * container queries on the stage rather than viewport breakpoints: at 1440px
 * with devtools docked right the stage is about 800px, and with the summary
 * open too it is about 360px.
 *
 * A transient notice, such as a refused gesture, floats just above the dock
 * rather than inside it. It takes no layout space, so the device or page
 * behind keeps its size and the controls stay where they are while refusals
 * come and go.
 */
export const DockShell = ({
  children,
  footer,
  notice,
  requests,
  status,
}: {
  /** The controls row: wordmark, session picker, and the actions. */
  readonly children: React.ReactNode;
  /**
   * A deliberate tier under the controls, such as a rename form. It counts
   * toward the space the stage reserves for the dock.
   */
  readonly footer?: React.ReactNode;
  /**
   * Transient notices such as refusals, as `DockNotice`s. They float above
   * the dock and never change the space the stage reserves for it.
   */
  readonly notice?: React.ReactNode;
  /** What the agent is waiting on, or nothing. */
  readonly requests?: React.ReactNode;
  readonly status: React.ReactNode;
}) => {
  const ref = useDockHeight();
  return (
    <div
      className="@container pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3"
      data-slot="workspace-dock-container"
    >
      <div className="relative w-full max-w-2xl">
        {/*
          Pointer events pass through the notices to the device or page
          behind, so a refusal never blocks the next attempt.
        */}
        <div
          className="absolute inset-x-0 bottom-full mb-2 flex flex-col items-center gap-1.5 empty:hidden"
          data-slot="dock-notices"
        >
          {notice}
        </div>
        <section
          aria-label="Workspace dock"
          className="material-float pointer-events-auto relative w-full overflow-hidden rounded-2xl shadow-lg"
          data-slot="workspace-dock"
          ref={ref}
        >
          {requests}
          {status}
          {/*
            The session picker shrinks before an action does. When the actions
            still do not fit, as on a narrow device dock, they wrap onto a
            second line rather than clipping.
          */}
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pt-1 pb-2"
            data-slot="dock-controls"
          >
            {children}
          </div>
          {footer}
        </section>
      </div>
    </div>
  );
};

/**
 * One transient notice above the dock: a refused gesture or a failed
 * control. It is announced as an alert without taking focus.
 */
export const DockNotice = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <p
    className="material-float text-destructive max-w-full rounded-lg px-3 py-1.5 text-xs text-pretty shadow-md"
    data-slot="dock-notice"
    role="alert"
  >
    {children}
  </p>
);

/** A spacer that pushes the actions to the end of the controls row. */
export const DockSpacer = () => (
  <div className="min-w-2 flex-1" data-slot="dock-spacer" />
);

/**
 * The mark alone, with the name kept for assistive technology: a session
 * dock spends its width on the session. It gives way first when the stage
 * narrows.
 */
export const DockWordmark = () => (
  <span className="hidden px-1 @2xl:inline-flex">
    <WatcherMark />
    <span className="sr-only">Contingency</span>
  </span>
);

/**
 * What the dock has to say above the browser rather than inside the card: a
 * refused gesture, a capture failure, a stream failure. What the agent is
 * waiting on is not here; it is the dock's own first tier.
 */
export const DockNotices = ({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) => (
  <div
    className={cn(
      "pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3",
      className
    )}
  >
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
 * How a dock state reads. Work in progress is `busy`, anything waiting on the
 * person is `attention`, a session someone is driving is `live`, and a good
 * outcome is `success`, so a resting dock and a dock that needs you never
 * look alike.
 */
export type DockStateTone =
  | "attention"
  | "busy"
  | "default"
  | "failed"
  | "live"
  | "recording"
  | "success";

const dockStateToneClass: Record<DockStateTone, string> = {
  attention: "text-amber-700 dark:text-amber-400",
  busy: "text-foreground/85",
  default: "text-foreground/85",
  failed: "text-destructive",
  live: "text-blue-600 dark:text-blue-400",
  recording: "text-red-600 dark:text-red-400",
  success: "text-emerald-700 dark:text-emerald-400",
};

/**
 * The tone's mark. Work in progress spins and a live recording pulses, so
 * motion means "it is moving"; the alert icon means "it is waiting on you"
 * or "it failed".
 */
const DockStateMark = ({ tone }: { readonly tone: DockStateTone }) => {
  switch (tone) {
    case "recording": {
      return (
        <span aria-hidden="true" className="relative flex size-2.5 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-red-500/60 motion-reduce:hidden" />
          <CircleIcon className="relative size-2.5 fill-current text-red-500" />
        </span>
      );
    }
    case "busy": {
      return (
        <LoaderCircleIcon
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
      );
    }
    case "attention":
    case "failed": {
      return (
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      );
    }
    case "success": {
      return (
        <CircleCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
      );
    }
    case "live": {
      return (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-blue-500"
        />
      );
    }
    default: {
      return (
        <span
          aria-hidden="true"
          className="bg-muted-foreground/60 size-1.5 shrink-0 rounded-full"
        />
      );
    }
  }
};

/**
 * A dock state as colored text behind a small mark. No fill, border, or edge,
 * so the status reads as a line rather than a pill.
 */
export const DockState = ({
  children,
  tone = "default",
}: {
  readonly children: React.ReactNode;
  readonly tone?: DockStateTone;
}) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1.5 text-[13px] leading-5 font-semibold whitespace-nowrap",
      dockStateToneClass[tone]
    )}
    data-slot="dock-state"
    data-tone={tone}
  >
    <DockStateMark tone={tone} />
    {children}
  </span>
);

/** A quiet fact beside the dock state, such as demo provenance. */
export const dockFactClassName =
  "text-muted-foreground block max-w-full truncate text-xs leading-5";

/**
 * The dock's status line: the state label, then one sentence saying where the
 * session is and what happens next. On a narrow stage the sentence takes its
 * own line under the label and wraps to two; from a 32rem stage it sits
 * beside the label on one line. The sentence keeps a 12rem floor: when the
 * badges and facts leave it less, it moves under them rather than vanishing,
 * and a fact too long for the card truncates instead of overflowing it. A clamped sentence expands in place, with
 * `details` (the Agent Step, the task) under it.
 *
 * One polite region, changed only when the state changes.
 */
export const DockStatus = ({
  badges,
  children,
  details,
  note,
}: {
  /** The state labels: a `DockState` and any quiet facts beside it. */
  readonly badges: React.ReactNode;
  readonly children: React.ReactNode;
  readonly details?: React.ReactNode;
  /** A line under the sentence that wraps rather than clamps, such as paths. */
  readonly note?: React.ReactNode;
}) => {
  const [expandedAtom] = useState(() => Atom.make(false));
  const [expanded, setExpanded] = useAtom(expandedAtom);
  const [sentenceRef, clamped] = useClamped<HTMLOutputElement>();
  const expandable = clamped || expanded || details !== undefined;
  return (
    <div className="px-3.5 pt-2 pb-0.5" data-slot="dock-status">
      <div className="flex min-w-0 items-start gap-2">
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5"
          data-slot="dock-status-line"
        >
          {badges}
          <output
            aria-live="polite"
            className={cn(
              "text-muted-foreground block min-w-0 basis-full text-[13px] leading-5 text-pretty wrap-anywhere empty:hidden",
              expanded
                ? "max-h-40 overflow-y-auto"
                : "line-clamp-2 @lg:line-clamp-1 @lg:min-w-48 @lg:flex-1 @lg:basis-0"
            )}
            ref={sentenceRef}
          >
            {children}
          </output>
        </div>
        {expandable ? (
          <Button
            aria-expanded={expanded}
            aria-label={expanded ? "Hide details" : "Show details"}
            className="-mr-1.5"
            onClick={() => setExpanded((current) => !current)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        ) : null}
      </div>
      {note === undefined ? null : (
        <p className="text-muted-foreground mt-0.5 font-mono text-xs wrap-anywhere">
          {note}
        </p>
      )}
      {expanded && details !== undefined ? (
        <div className="mt-2 max-h-56 space-y-3 overflow-y-auto border-t pt-2">
          {details}
        </div>
      ) : null}
    </div>
  );
};
