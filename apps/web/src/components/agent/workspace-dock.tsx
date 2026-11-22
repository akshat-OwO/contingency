import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  GlobeIcon,
  HandIcon,
  MessageSquareTextIcon,
  MousePointer2Icon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";
import { RunSummaryPill } from "@/components/agent/run-summary-dock";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DialogCombobox,
  DialogComboboxContent,
  DialogComboboxTitle,
  DialogComboboxTrigger,
} from "@/components/ui/dialog-combobox";
import {
  Listbox,
  ListboxItem,
  ListboxItemIndicator,
} from "@/components/ui/listbox";
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

/** The prototype's session popover: an opaque island, not a plain menu. */
export const dockSessionPopoverClassName =
  "bg-island-solid border-island-border shadow-island w-[380px] max-w-[calc(100vw-2rem)] gap-0 rounded-[22px] border p-1.5 ring-0";

export const dockSessionTitleClassName =
  "text-muted-foreground/70 mx-2.5 my-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase";

/**
 * A session in the picker: its platform glyph, its name over its kind, and a
 * check while it is the one shown. Laid over the ghost Button look, it keeps
 * the look the rows had before they became options.
 */
export const dockSessionOptionClassName =
  "hover:bg-island-hover data-selected:bg-island-hover focus-visible:ring-ring grid h-auto min-w-0 grid-cols-[32px_minmax(0,1fr)_auto] items-center justify-start gap-3 rounded-[14px] py-[7px] pr-2 pl-[7px] text-left font-normal";

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
    <DialogCombobox open={open} onOpenChange={setOpen}>
      <DialogComboboxTrigger
        aria-label="Agent Session"
        // The home's "In progress" heading morphs into this trigger.
        data-vt="switcher"
        // The trigger shows the name's start; hovering shows all of it.
        title={selected === undefined ? undefined : agentSessionLabel(selected)}
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
      </DialogComboboxTrigger>
      <DialogComboboxContent
        aria-label="Agent Sessions"
        side="bottom"
        sideOffset={14}
        className={dockSessionPopoverClassName}
      >
        <DialogComboboxTitle className={dockSessionTitleClassName}>
          Agent Sessions
        </DialogComboboxTitle>
        {/*
          The sessions are one listbox: one tab stop, with arrows between
          them. A listbox holds only options, so each session's Delete
          button sits in a column beside it, on the same row through
          subgrid.
        */}
        <div
          className={cn(
            "grid max-h-72 gap-x-1 gap-y-0.5 overflow-y-auto",
            deletion === undefined
              ? "grid-cols-1"
              : "grid-cols-[minmax(0,1fr)_auto]"
          )}
          style={{
            gridTemplateRows: `repeat(${sessions.length}, auto)`,
          }}
        >
          <Listbox
            activation="manual"
            aria-label="Agent Sessions"
            className="row-span-full grid grid-rows-subgrid"
            // Choosing the shown session asks to unchoose it; it stays
            // chosen, and the picker closes as for any choice.
            deselectable
            onValueChange={(next) => {
              const chosen = next ?? selectedSessionId;
              if (chosen !== undefined) {
                onSelect(chosen);
              }
              setOpen(false);
            }}
            value={selectedSessionId ?? null}
          >
            {sessions.map((session) => {
              const label = agentSessionLabel(session);
              const separator = label.lastIndexOf(" · ");
              const name = separator === -1 ? label : label.slice(0, separator);
              const kind =
                separator === -1 ? "Teaching" : label.slice(separator + 3);
              return (
                <ListboxItem
                  aria-label={label}
                  className={buttonVariants({
                    className: dockSessionOptionClassName,
                    size: "md",
                    variant: "ghost",
                  })}
                  key={session.id}
                  value={session.id}
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
                  <ListboxItemIndicator>
                    <CheckIcon
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                  </ListboxItemIndicator>
                </ListboxItem>
              );
            })}
          </Listbox>
          {deletion === undefined ? null : (
            <div className="row-span-full grid grid-rows-subgrid">
              {sessions.map((session) => {
                const label = agentSessionLabel(session);
                return (
                  <div className="grid place-items-center" key={session.id}>
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
                  </div>
                );
              })}
            </div>
          )}
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
              size="md"
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
      </DialogComboboxContent>
    </DialogCombobox>
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
            {/*
              Every Button and Toggle among the controls takes the dock's
              compact size, and all but the primary action stay unfilled.
            */}
            <div
              className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 empty:hidden [&>:is([data-slot=button],[data-slot=toggle])]:h-8 [&>:is([data-slot=button],[data-slot=toggle])]:rounded-[10px] [&>:is([data-slot=button],[data-slot=toggle])]:px-3 [&>:is([data-slot=button],[data-slot=toggle])]:text-[13px] [&>:is([data-slot=button],[data-slot=toggle])]:not-[.bg-primary,.bg-status-recording]:bg-transparent dark:[&>:is([data-slot=button],[data-slot=toggle])]:not-[.bg-primary,.bg-status-recording]:bg-transparent"
              data-slot="dock-controls"
            >
              <RunSummaryPill />
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
  center,
  className,
  flows,
  picker,
}: {
  /** An island centred between the two, such as a Web session's device bar. */
  readonly center?: React.ReactNode;
  readonly className?: string;
  /** The Flows link. */
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
      className="island pointer-events-auto flex min-w-0 shrink items-center gap-1 p-1"
    >
      <WorkspaceHomeLink wordmark />
      <span aria-hidden="true" className="bg-island-border h-5 w-px shrink-0" />
      {picker}
    </nav>
    {center === undefined ? null : (
      <div className="flex max-w-[720px] min-w-0 flex-1 justify-center">
        {center}
      </div>
    )}
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
    {/*
      Only each notice's own box takes pointer input, so the gaps between
      notices and beside a narrow one still reach the stream (ADR 0076).
    */}
    <div className="pointer-events-none max-h-[60svh] w-full max-w-5xl space-y-2 overflow-y-auto *:pointer-events-auto">
      {children}
    </div>
  </div>
);

/**
 * How a dock state reads. Work in progress is `busy`, anything waiting on the
 * person is `attention`, a session the user is driving is `live`, a good
 * outcome or a state ready for the next step is `success`, and a session with
 * nothing left to drive is `ended`, so a resting dock and a dock that needs
 * you never look alike.
 */
export type DockStateTone =
  | "attention"
  | "busy"
  | "default"
  | "ended"
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
  ended: { className: "[--status-tone:var(--muted-foreground)]" },
  failed: { className: "[--status-tone:var(--destructive)]" },
  live: { className: "[--status-tone:var(--foreground)]" },
  recording: { status: "recording" },
  success: { status: "ready" },
};

/**
 * Work in progress as a still progress ring, a quarter full: like the
 * prototype's Running mark, it never spins.
 */
const BusyRing = () => {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg
      aria-hidden="true"
      className="size-3.5 shrink-0 -rotate-90 fill-none stroke-[2.25]"
      viewBox="0 0 16 16"
    >
      <circle className="stroke-current/20" cx="8" cy="8" r="6" />
      <circle
        className="stroke-current"
        cx="8"
        cy="8"
        r="6"
        strokeDasharray={`${circumference / 4} ${circumference}`}
        strokeLinecap="round"
      />
    </svg>
  );
};

/**
 * The tone's mark, as the prototype's status chips draw them (#753). None of
 * them move: work in progress is a still ring, waiting on you is a hand, the
 * user driving is a pointer, a good or ready state is a check, an ended
 * session is a stop square, and a failure is the alert icon. Recording is a
 * ringed dot.
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
      return <BusyRing />;
    }
    case "attention": {
      return <HandIcon aria-hidden="true" className="size-3.5 shrink-0" />;
    }
    case "live": {
      return (
        <MousePointer2Icon aria-hidden="true" className="size-3.5 shrink-0" />
      );
    }
    case "failed": {
      return (
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      );
    }
    case "success": {
      return <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />;
    }
    case "ended": {
      return (
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-[2px] bg-current"
        />
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
 * line, and drops to an icon on a narrow stage so the chip and the action keep
 * their room. Either way it is a button: it opens the whole sentence, with
 * `details` (the Agent Step, the task) under it, in a card above the island,
 * so reading it never resizes the status island (#753).
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
}) => (
  <div className="flex min-w-0 flex-col" data-slot="dock-status">
    <div
      className="flex min-w-0 items-center gap-1.5"
      data-slot="dock-status-line"
    >
      {badges}
      <output aria-live="polite" className="flex min-w-0 empty:hidden">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                className="text-muted-foreground hover:bg-island-hover hover:text-foreground aria-expanded:bg-island-hover aria-expanded:text-foreground h-7 max-w-60 min-w-0 justify-start rounded-lg px-1.5 text-[12.5px] font-normal @4xl:px-1"
                size="sm"
                type="button"
                variant="ghost"
              />
            }
          >
            <MessageSquareTextIcon aria-hidden="true" className="@4xl:hidden" />
            <span className="min-w-0 truncate @max-4xl:sr-only">
              {children}
            </span>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="bg-island-solid border-island-border shadow-island w-80 max-w-[calc(100vw-2rem)] gap-2.5 rounded-[22px] border px-3.5 pt-3 pb-3.5 ring-0"
            side="top"
            sideOffset={14}
          >
            <PopoverTitle className="sr-only">Status</PopoverTitle>
            <p className="text-[13px] leading-normal text-pretty">{children}</p>
            {details === undefined ? null : (
              <div className="max-h-56 space-y-3 overflow-y-auto border-t pt-2.5">
                {details}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </output>
    </div>
    {note === undefined ? null : (
      <p className="text-muted-foreground mt-1 max-w-96 px-1 font-mono text-xs wrap-anywhere whitespace-normal">
        {note}
      </p>
    )}
  </div>
);
