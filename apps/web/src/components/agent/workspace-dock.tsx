import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { useWorkspaceHome } from "./workspace-home-context";
import {
  islandControlClassName,
  WorkspaceHomeLink,
} from "./workspace-home-nav";

/**
 * The pieces every session's chrome is made of. Teaching, a Dry Run and an
 * Interactive Run, on every platform, render the same islands over the same
 * stage, so the shell lives here rather than inside the activity that
 * happened to need it first (#209, #753).
 */

/**
 * A session label reads `Flow · Activity`, or the bare Flow name
 * while teaching. The name is what a person picks by, so it leads; the
 * activity is a quiet second column that still tells two sessions of one
 * Flow apart. The option's accessible name is the whole label.
 */
/** Deletion stays in the session picker and never selects the deleted row. */
export interface SessionDeletion {
  readonly onDelete: (sessionId: AgentSessionId) => void;
  readonly pending: boolean;
  readonly error: string | undefined;
}

/**
 * Every session switcher trigger, in the top bar's navigation island: quiet,
 * and the first thing to shrink when the stage is narrow.
 */
export const dockSessionTriggerClassName =
  "hover:bg-island-hover data-[popup-open]:bg-island-hover h-[34px] min-w-0 max-w-80 shrink justify-start gap-2 rounded-xl pr-2 pl-3 text-sm font-medium";

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
  const home = useWorkspaceHome();
  const selected = sessions.find(({ id }) => id === selectedSessionId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Agent Session"
        // The home's "In progress" heading morphs into this trigger.
        data-vt="switcher"
        // The trigger shows the name's start; hovering shows all of it.
        title={selected === undefined ? undefined : agentSessionLabel(selected)}
        role="combobox"
        aria-haspopup="dialog"
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
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="text-muted-foreground/70 size-3.5"
        />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Agent Sessions"
        align="start"
        side="bottom"
        sideOffset={14}
        // The prototype's popover: an opaque island, not a plain menu.
        className="bg-island-solid border-island-border shadow-island w-[380px] max-w-[calc(100vw-2rem)] gap-0 rounded-[22px] border p-1.5 ring-0"
      >
        <PopoverTitle className="text-muted-foreground/70 mx-2.5 my-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase">
          Agent Sessions
        </PopoverTitle>
        <div className="grid max-h-72 gap-0.5 overflow-y-auto">
          {sessions.map((session) => {
            const label = agentSessionLabel(session);
            const separator = label.lastIndexOf(" · ");
            const name = separator === -1 ? label : label.slice(0, separator);
            const kind =
              separator === -1 ? "Teaching" : label.slice(separator + 3);
            const current = session.id === selectedSessionId;
            return (
              <div key={session.id} className="flex items-center gap-1">
                <Button
                  aria-label={label}
                  aria-pressed={current}
                  className="hover:bg-island-hover aria-pressed:bg-island-hover grid h-auto min-w-0 flex-1 grid-cols-[32px_minmax(0,1fr)_auto] items-center justify-start gap-3 rounded-[14px] py-[7px] pr-2 pl-[7px] text-left font-normal"
                  onClick={() => {
                    onSelect(session.id);
                    setOpen(false);
                  }}
                  variant="ghost"
                >
                  <span className="bg-island-hover ring-island-border grid size-8 place-items-center rounded-[10px] ring-1 ring-inset">
                    <GlobeIcon aria-hidden="true" className="size-[17px]" />
                  </span>
                  <span className="grid min-w-0">
                    <span className="truncate font-medium">{name}</span>
                    <span className="text-muted-foreground text-xs">
                      {kind} · Web
                    </span>
                  </span>
                  {current ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
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
          <p role="alert" className="text-destructive px-2.5 py-1 text-xs">
            {deletion.error}
          </p>
        )}
        {home === null ? null : (
          <>
            <hr className="border-island-border mx-1 my-1.5 border-t" />
            {/* A new session of any platform starts on the Workspace home. */}
            <Button
              className="hover:bg-island-hover h-[34px] w-full justify-start gap-[7px] rounded-xl px-3 text-sm font-medium"
              onClick={() => {
                setOpen(false);
                home.goHome();
              }}
              variant="ghost"
            >
              <PlusIcon aria-hidden="true" />
              New session
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};

/**
 * Publishes the height of the session status island on the stage it floats
 * over as `--dock-height`, so a stage can keep its content clear of it.
 * Requests and notices float over the stage outside the measured element, so
 * a request or a refusal coming and going never resizes the stage's content.
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
 * The Requests island, as the prototype's request card: a brand wash that
 * fades under the header and a lifted shadow. It is its own size container,
 * so what is inside sizes itself to the card, not to the stage.
 */
const requestsIslandClassName =
  "island @container pointer-events-auto max-w-full flex-[0_1_28rem] overflow-hidden rounded-[26px] shadow-[var(--island-shadow-lift),inset_0_1px_0_color-mix(in_oklch,var(--island-brand)_22%,transparent)] bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--island-brand)_9%,transparent),transparent_72px),var(--island)]";

/**
 * The session's chrome along the bottom of the stage, split into islands
 * (#753). What the agent is waiting on sits in the **Requests** island at the
 * bottom left, only while there is something to answer. The **Session
 * status** island at the bottom right holds the state, the next step, the
 * activity's tools and the one action. The brand, the session switcher and
 * Flows live in the `SessionTopBar` instead.
 *
 * The dock sits inside the browser or device stage, which the devtools
 * inspector and a Run Summary narrow independently of the window. So it
 * sizes itself to the stage rather than the viewport. Session status never
 * shrinks for a request: when the two do not fit side by side, the requests
 * wrap onto their own line above it, so a request coming, going or collapsing
 * never moves the status island's controls or changes the height the stage
 * reserves for it.
 *
 * A transient notice, such as a refused gesture, floats at the top centre of
 * the stage. It takes no layout space and lets pointer input through, so the
 * device or page keeps its size and the next attempt is never blocked.
 */
export const DockShell = ({
  children,
  footer,
  notice,
  requests,
  status,
}: {
  /** The activity's tools and its one action. */
  readonly children: React.ReactNode;
  /**
   * A deliberate tier under the controls, such as a rename form. It counts
   * toward the space the stage reserves for the status island.
   */
  readonly footer?: React.ReactNode;
  /** Transient notices such as refusals, as `DockNotice`s. */
  readonly notice?: React.ReactNode;
  /** What the agent is waiting on, or nothing. */
  readonly requests?: React.ReactNode;
  readonly status: React.ReactNode;
}) => {
  const ref = useDockHeight();
  return (
    <>
      <div
        className="pointer-events-none absolute inset-x-0 top-3 z-30 flex flex-col items-center gap-1.5 px-3 empty:hidden"
        data-slot="dock-notices"
      >
        {notice}
      </div>
      <div
        className="@container pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3"
        data-slot="workspace-dock-container"
      >
        <div className="flex flex-wrap items-end justify-end gap-2">
          <section
            aria-label="Requests"
            className={cn(
              requestsIslandClassName,
              // Each request's body lines up under its title, past the icon tile.
              "mr-auto empty:hidden [&>*:last-child]:border-b-0 [&>*>section>*:not(:first-child)]:ml-11"
            )}
            data-slot="dock-requests"
          >
            {requests}
          </section>
          <section
            aria-label="Session status"
            // Sized to its content, as in the prototype: chip, sentence,
            // tools and the one action, with no empty run between them.
            className="island pointer-events-auto ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1.5 overflow-hidden rounded-3xl py-2 pr-2 pl-3 whitespace-nowrap"
            data-slot="workspace-dock"
            ref={ref}
          >
            {status}
            {/*
              The tools shrink before the action does. When they still do not
              fit, as on a narrow device stage, they wrap onto a second line
              rather than clipping.
            */}
            <div
              className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 empty:hidden *:data-[slot=button]:h-10 *:data-[slot=button]:rounded-[13px] *:data-[slot=button]:px-4 *:data-[slot=button]:text-sm"
              data-slot="dock-controls"
            >
              {children}
            </div>
            <div className="-mr-2 -mb-2 -ml-3 basis-full whitespace-normal empty:hidden">
              {footer}
            </div>
          </section>
        </div>
      </div>
    </>
  );
};

/**
 * One transient notice at the top centre of the stage: a refused gesture or a
 * failed control. It is announced as an alert without taking focus.
 */
export const DockNotice = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <p
    className="island text-destructive shadow-island-lift max-w-md rounded-full px-4 py-2 text-xs font-medium text-pretty"
    data-slot="dock-notice"
    role="alert"
  >
    {children}
  </p>
);

/**
 * The session's top chrome (#753): the **Contingency home** wordmark and the
 * session switcher in a navigation island at the top left, and Flows, Docs and
 * the theme in an island at the top right, as on the Workspace home.
 */
export const SessionTopBar = ({
  className,
  flows,
  picker,
}: {
  readonly className?: string;
  /** The Flows drawer entry, or nothing while capture hides it. */
  readonly flows?: React.ReactNode;
  /** The session switcher. */
  readonly picker: React.ReactNode;
}) => (
  <div
    className={cn(
      "pointer-events-none z-20 flex items-center justify-between gap-3 px-3 py-2",
      className
    )}
    data-slot="session-top-bar"
  >
    <nav
      aria-label="Workspace"
      className="island pointer-events-auto flex min-w-0 items-center gap-1 p-1"
    >
      <WorkspaceHomeLink wordmark />
      <span aria-hidden="true" className="bg-island-border h-5 w-px shrink-0" />
      {picker}
    </nav>
    <div className="island pointer-events-auto flex shrink-0 items-center gap-1 p-1">
      {flows}
      <DocsLink className={islandControlClassName} />
      <ModeToggle className={islandControlClassName} />
    </div>
  </div>
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

/**
 * Each tone as the prototype's status chip (`status-chip` in styles.css): the
 * session list on the home and the dock read a state the same way.
 */
const dockStateChip: Record<
  DockStateTone,
  { readonly className?: string; readonly status?: string }
> = {
  attention: { status: "needs-you" },
  busy: { status: "running" },
  default: { className: "[--status-tone:var(--muted-foreground)]" },
  failed: { className: "[--status-tone:var(--destructive)]" },
  live: { className: "[--status-tone:var(--foreground)]" },
  recording: { status: "recording" },
  success: { status: "ready" },
};

/**
 * The tone's mark. Work in progress spins; the alert icon means "it is
 * waiting on you" or "it failed". Recording is a ringed dot that holds still.
 */
const DockStateMark = ({ tone }: { readonly tone: DockStateTone }) => {
  switch (tone) {
    case "recording": {
      return (
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 scale-75 rounded-full bg-current shadow-[0_0_0_2px_var(--island-solid),0_0_0_3.5px_currentColor]"
        />
      );
    }
    case "busy": {
      return (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
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
    default: {
      return (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-current"
        />
      );
    }
  }
};

/** A dock state as a tinted chip behind a small mark, as in the prototype. */
export const DockState = ({
  children,
  tone = "default",
}: {
  readonly children: React.ReactNode;
  readonly tone?: DockStateTone;
}) => (
  <span
    className={cn("status-chip shrink-0", dockStateChip[tone].className)}
    data-slot="dock-state"
    data-status={dockStateChip[tone].status}
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
 * The status island's line: the state chip, any quiet facts beside it, and
 * one short sentence saying what happens next. The sentence truncates to one
 * line and shows whole on hover, and drops on a narrow stage so the chip and
 * the action keep their room. `details` (the Agent Step, the task) open under
 * the line from a toggle.
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
  return (
    <div className="flex min-w-0 flex-col" data-slot="dock-status">
      <div
        className="flex min-w-0 items-center gap-1.5"
        data-slot="dock-status-line"
      >
        {badges}
        <output
          aria-live="polite"
          className={cn(
            "text-muted-foreground hidden min-w-0 px-1 text-[12.5px] leading-5 empty:hidden @4xl:block",
            expanded
              ? "max-w-80 text-pretty whitespace-normal"
              : "max-w-60 truncate"
          )}
        >
          {children}
        </output>
        {details === undefined ? null : (
          <Button
            aria-expanded={expanded}
            aria-label={expanded ? "Hide details" : "Show details"}
            onClick={() => setExpanded((current) => !current)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        )}
      </div>
      {note === undefined ? null : (
        <p className="text-muted-foreground mt-1 max-w-96 px-1 font-mono text-xs wrap-anywhere whitespace-normal">
          {note}
        </p>
      )}
      {expanded && details !== undefined ? (
        <div className="mt-2 max-h-56 max-w-96 space-y-3 overflow-y-auto border-t px-1 pt-2 whitespace-normal">
          {details}
        </div>
      ) : null}
    </div>
  );
};
