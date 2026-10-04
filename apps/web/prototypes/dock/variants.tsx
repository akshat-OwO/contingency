import {
  ChevronDownIcon,
  ChevronUpIcon,
  InfoIcon,
  MinusIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  DockShell,
  DockStatus,
  Wordmark,
} from "@/components/agent/workspace-dock";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import type { DockModel } from "./fixtures";
import { LegacyNotices } from "./legacy-notices";
import {
  CommentButton,
  ControlError,
  Coverage,
  Elapsed,
  Idle,
  OverflowMenu,
  PrimaryAction,
  ProvenanceBadge,
  Secondaries,
  NativeSessionSelect,
  SessionSelect,
  StateBadge,
  StepDetails,
  TaskDetails,
  TaskDetailsBody,
} from "./parts";
import { DockRequests } from "./requests";

export interface DockVariant {
  readonly blurb: string;
  readonly Dock: (props: { readonly model: DockModel }) => React.ReactNode;
  /**
   * How much of the stage's bottom edge the dock covers, so the browser frame
   * keeps clear of it the way `AgentBrowserCanvas` does with `pb-24`.
   */
  readonly reserve: string;
  readonly title: string;
}

/**
 * Whether a clamped line actually hides text. The expand control only renders
 * when there is something to expand, and the observer follows the dock as the
 * devtools or the summary change the stage's width.
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
      setClamped(
        element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1
      );
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

/** The floating wrapper every overlay prototype shares, sized by the stage. */
const FloatingDock = ({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) => (
  <div
    className={cn(
      "@container pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 p-3",
      className
    )}
  >
    {children}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Current: the shipped RunDock and TeachingRecordingDock, for comparison.     */
/* -------------------------------------------------------------------------- */

const CurrentDockShell = ({ model }: { readonly model: DockModel }) => {
  if (model.activity === "teaching") {
    return (
      <DockShell fit>
        <Wordmark />
        <NativeSessionSelect model={model} />
        <StateBadge model={model} />
        <Elapsed model={model} />
        <CommentButton model={model} />
        <Popover>
          <PopoverTrigger
            render={(props) => (
              <Button
                {...props}
                aria-label="Show details"
                size="icon-sm"
                variant="ghost"
              >
                <InfoIcon />
              </Button>
            )}
          />
          <PopoverContent align="end" className="w-80">
            <PopoverHeader>
              <PopoverTitle>{model.badge}</PopoverTitle>
              <PopoverDescription>{model.sentence}</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
        <Secondaries model={model} />
        <PrimaryAction model={model} />
      </DockShell>
    );
  }
  return (
    <DockShell>
      <Wordmark />
      <NativeSessionSelect model={model} />
      <StateBadge model={model} />
      <ProvenanceBadge model={model} />
      <DockStatus>
        {model.badge}. {model.sentence}
      </DockStatus>
      <TaskDetails model={model} />
      <Coverage model={model} />
      <Idle model={model} />
      <PrimaryAction model={model} />
      {model.error === undefined ? null : (
        <p className="text-destructive w-full text-xs">{model.error}</p>
      )}
    </DockShell>
  );
};

/** Today's dock, with today's request cards floating at the top. */
const CurrentDock = ({ model }: { readonly model: DockModel }) => (
  <>
    <LegacyNotices model={model} />
    <CurrentDockShell model={model} />
  </>
);

/* -------------------------------------------------------------------------- */
/* A. Two-tier card: a status line above one toolbar row that never wraps.     */
/* -------------------------------------------------------------------------- */

const StackedDock = ({ model }: { readonly model: DockModel }) => {
  const [expanded, setExpanded] = useState(false);
  const [sentenceRef, clamped] = useClamped<HTMLParagraphElement>();
  const expandable = clamped || expanded || model.step !== undefined;
  return (
    <FloatingDock>
      <section
        aria-label="Workspace dock"
        className="bg-background pointer-events-auto w-full max-w-3xl overflow-hidden rounded-xl border shadow-lg"
      >
        <DockRequests model={model} />
        <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
          {/*
            The sentence keeps a floor on its width, like \`DockStatus\`: when
            the badges leave less than that, it drops onto its own line rather
            than ellipsizing after two words.
          */}
          <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-1">
            <div className="flex shrink-0 items-center gap-1.5 pt-px">
              <StateBadge model={model} />
              <span className="hidden @lg:contents">
                <ProvenanceBadge model={model} />
              </span>
            </div>
            <div className="min-w-48 flex-1">
              <p
                aria-live="polite"
                className={cn(
                  "text-muted-foreground text-xs leading-5 text-pretty",
                  expanded ? "max-h-40 overflow-y-auto" : "line-clamp-1"
                )}
                ref={sentenceRef}
              >
                {model.sentence}
              </p>
              {expanded && model.step !== undefined ? (
                <div className="bg-muted/50 mt-2 rounded-md p-2">
                  <StepDetails model={model} />
                </div>
              ) : null}
              {expanded && model.task !== undefined ? (
                <div className="mt-2 max-h-40 overflow-y-auto border-t pt-2">
                  <TaskDetailsBody model={model} />
                </div>
              ) : null}
            </div>
          </div>
          {expandable || model.task !== undefined ? (
            <Button
              aria-expanded={expanded}
              aria-label={expanded ? "Show less" : "Show more"}
              className="-mt-0.5 -mr-1"
              onClick={() => setExpanded((current) => !current)}
              size="icon-xs"
              variant="ghost"
            >
              {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
          <span className="hidden pl-1 @2xl:inline">
            <Wordmark />
          </span>
          <SessionSelect className="max-w-[14rem] shrink" model={model} />
          <Elapsed model={model} />
          <div className="min-w-2 flex-1" />
          <span className="hidden @md:contents">
            <Idle compact model={model} />
          </span>
          <span className="hidden @xl:contents">
            <Coverage compact model={model} />
          </span>
          <span className="contents @md:hidden">
            <CommentButton compact model={model} />
          </span>
          <span className="hidden @md:contents">
            <CommentButton model={model} />
          </span>
          <span className="hidden @xl:contents">
            <Secondaries model={model} />
          </span>
          <OverflowMenu className="@xl:hidden" model={model} withCoverage />
          <PrimaryAction model={model} />
        </div>
        {model.error === undefined ? null : (
          <div className="border-t px-3 py-1.5">
            <ControlError model={model} />
          </div>
        )}
      </section>
    </FloatingDock>
  );
};

/* -------------------------------------------------------------------------- */
/* B. One-line pill: the sentence truncates into a details popover.            */
/* -------------------------------------------------------------------------- */

const PillDock = ({ model }: { readonly model: DockModel }) => (
  <FloatingDock>
    {model.error === undefined ? null : (
      <p className="bg-background text-destructive pointer-events-auto max-w-5xl rounded-lg border px-3 py-1.5 text-xs shadow-sm">
        {model.error}
      </p>
    )}
    <section
      aria-label="Workspace dock"
      className="bg-background pointer-events-auto flex h-12 w-full max-w-5xl items-center gap-1.5 rounded-xl border px-2 shadow-lg"
    >
      <span className="hidden pl-1 @4xl:inline">
        <Wordmark />
      </span>
      <SessionSelect className="hidden max-w-[11rem] @lg:block" model={model} />
      <StateBadge model={model} />
      <span className="hidden @2xl:contents">
        <ProvenanceBadge model={model} />
      </span>
      <Elapsed model={model} />
      <output aria-live="polite" className="sr-only">
        {model.badge}. {model.sentence}
      </output>
      <Popover>
        <PopoverTrigger
          render={(props) => (
            <Button
              {...props}
              aria-label="Show details"
              className="text-muted-foreground min-w-0 flex-1 justify-start font-normal"
              size="sm"
              variant="ghost"
            >
              <InfoIcon aria-hidden="true" />
              <span className="hidden min-w-0 truncate text-xs @md:inline">
                {model.sentence}
              </span>
            </Button>
          )}
        />
        <PopoverContent
          align="start"
          className="max-h-[60svh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
          side="top"
        >
          <PopoverHeader>
            <PopoverTitle>{model.badge}</PopoverTitle>
            <PopoverDescription className="text-pretty">
              {model.sentence}
            </PopoverDescription>
          </PopoverHeader>
          {model.step === undefined ? null : (
            <div className="border-t pt-2">
              <StepDetails model={model} />
            </div>
          )}
          {model.task === undefined ? null : (
            <div className="border-t pt-2">
              <TaskDetailsBody model={model} />
            </div>
          )}
        </PopoverContent>
      </Popover>
      <span className="hidden @xl:contents">
        <Idle compact model={model} />
        <Coverage compact model={model} />
      </span>
      <CommentButton compact model={model} />
      <span className="hidden @3xl:contents">
        <Secondaries model={model} />
      </span>
      <OverflowMenu className="@xl:max-@3xl:inline-flex hidden" model={model} />
      <OverflowMenu
        className="@lg:max-@xl:inline-flex hidden"
        model={model}
        withCoverage
      />
      <OverflowMenu
        className="@lg:hidden"
        model={model}
        withCoverage
        withSessions
      />
      <Separator className="mx-0.5 h-5" orientation="vertical" />
      <PrimaryAction model={model} />
    </section>
  </FloatingDock>
);

/* -------------------------------------------------------------------------- */
/* C. Agent bubble: the narration floats above a compact controls-only dock.   */
/* -------------------------------------------------------------------------- */

const BubbleDock = ({ model }: { readonly model: DockModel }) => {
  const [minimised, setMinimised] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sentenceRef, clamped] = useClamped<HTMLParagraphElement>();
  const speaker = model.activity === "run" ? "Agent" : "Next step";
  return (
    <FloatingDock className="items-stretch @3xl:items-center">
      <div className="pointer-events-none flex w-full max-w-2xl flex-col gap-2 self-center">
        {minimised ? null : (
          <Bubble
            className="pointer-events-auto max-w-full shadow-md"
            variant={model.tone === "failed" ? "destructive" : "outline"}
          >
            <BubbleContent className="w-full">
              <div className="mb-0.5 flex items-center gap-1.5">
                <SparklesIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5"
                />
                <span className="text-xs font-medium">{speaker}</span>
                <ProvenanceBadge model={model} />
                <div className="flex-1" />
                {clamped || expanded ? (
                  <Button
                    aria-expanded={expanded}
                    onClick={() => setExpanded((current) => !current)}
                    size="xs"
                    variant="ghost"
                  >
                    {expanded ? "Less" : "More"}
                  </Button>
                ) : null}
                <Button
                  aria-label="Hide status"
                  onClick={() => setMinimised(true)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <MinusIcon />
                </Button>
              </div>
              <p
                aria-live="polite"
                className={cn(
                  "text-sm text-pretty",
                  expanded ? "max-h-48 overflow-y-auto" : "line-clamp-2"
                )}
                ref={sentenceRef}
              >
                {model.sentence}
              </p>
              <ControlError model={model} />
            </BubbleContent>
          </Bubble>
        )}
      </div>
      <section
        aria-label="Workspace dock"
        className="bg-background pointer-events-auto flex h-12 max-w-full min-w-0 items-center gap-1.5 self-center rounded-xl border px-2 shadow-lg"
      >
        <span className="hidden pl-1 @3xl:inline">
          <Wordmark />
        </span>
        <SessionSelect
          className="hidden max-w-[10rem] @md:block"
          model={model}
        />
        <StateBadge model={model} />
        <Elapsed model={model} />
        {minimised ? (
          <Button
            aria-label="Show status"
            onClick={() => setMinimised(false)}
            size="icon-sm"
            variant="ghost"
          >
            <SparklesIcon />
          </Button>
        ) : null}
        <span className="hidden @lg:contents">
          <Idle compact model={model} />
          <Coverage compact model={model} />
        </span>
        <TaskDetails icon model={model} />
        <CommentButton compact model={model} />
        <span className="hidden @2xl:contents">
          <Secondaries model={model} />
        </span>
        <OverflowMenu
          className="@md:max-@2xl:inline-flex hidden"
          model={model}
        />
        <OverflowMenu className="@md:hidden" model={model} withSessions />
        <PrimaryAction model={model} />
      </section>
    </FloatingDock>
  );
};

/* -------------------------------------------------------------------------- */
/* D. Edge bar: a status bar attached to the stage's bottom edge.              */
/* -------------------------------------------------------------------------- */

const EdgeBarDock = ({ model }: { readonly model: DockModel }) => {
  const [expanded, setExpanded] = useState(false);
  const [sentenceRef, clamped] = useClamped<HTMLParagraphElement>();
  return (
    <div className="@container absolute inset-x-0 bottom-0 z-20">
      {expanded ? (
        <div className="bg-background/95 animate-in slide-in-from-bottom-2 fade-in-0 max-h-56 overflow-y-auto border-t px-4 py-3 backdrop-blur duration-150">
          <p className="text-sm text-pretty">{model.sentence}</p>
          {model.step === undefined ? null : (
            <div className="mt-3">
              <StepDetails model={model} />
            </div>
          )}
          {model.task === undefined ? null : (
            <div className="mt-3 border-t pt-3">
              <TaskDetailsBody model={model} />
            </div>
          )}
        </div>
      ) : null}
      <section
        aria-label="Workspace dock"
        className="bg-background/95 flex flex-col border-t backdrop-blur @3xl:h-12 @3xl:flex-row @3xl:items-center"
      >
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 px-3 @3xl:h-full">
          <span className="hidden @5xl:inline">
            <Wordmark />
          </span>
          <Separator className="hidden h-5 @5xl:block" orientation="vertical" />
          <StateBadge model={model} />
          <span className="hidden @lg:contents">
            <ProvenanceBadge model={model} />
          </span>
          <Elapsed model={model} />
          <button
            aria-expanded={expanded}
            className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-left text-xs outline-none focus-visible:underline"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            <span
              aria-live="polite"
              className="min-w-0 truncate"
              ref={sentenceRef}
            >
              {model.sentence}
            </span>
            {clamped || expanded || model.task !== undefined ? (
              expanded ? (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              ) : (
                <ChevronUpIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              )
            ) : null}
          </button>
        </div>
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-t px-2 @3xl:h-full @3xl:border-t-0 @3xl:border-l">
          <SessionSelect className="max-w-[12rem] shrink" model={model} />
          <div className="flex-1 @3xl:hidden" />
          <span className="hidden @md:contents">
            <Idle compact model={model} />
            <Coverage compact model={model} />
          </span>
          <CommentButton compact model={model} />
          <span className="hidden @xl:contents">
            <Secondaries model={model} />
          </span>
          <OverflowMenu className="@xl:hidden" model={model} />
          <PrimaryAction model={model} />
        </div>
        {model.error === undefined ? null : (
          <div className="border-t px-3 py-1.5">
            <ControlError model={model} />
          </div>
        )}
      </section>
    </div>
  );
};

export const variants = {
  current: {
    blurb:
      "What ships today. The Run dock wraps its controls under the sentence whenever the viewport is wide but the stage is not.",
    Dock: CurrentDock,
    reserve: "6rem",
    title: "Current",
  },
  stacked: {
    blurb:
      "A two-tier card. The agent's sentence gets its own clamped line with an expand chevron; every control sits on one toolbar row that never wraps and overflows into a menu.",
    Dock: StackedDock,
    reserve: "7.5rem",
    title: "A · Two-tier card",
  },
  pill: {
    blurb:
      "One fixed-height row. The sentence fills whatever width is left and truncates; clicking it opens the full text, the Agent Step, and the task in one popover.",
    Dock: PillDock,
    reserve: "5rem",
    title: "B · One-line pill",
  },
  bubble: {
    blurb:
      "The agent speaks in a bubble above a compact, controls-only dock. The bubble clamps to two lines, expands on demand, and can be minimised to an icon.",
    Dock: BubbleDock,
    reserve: "9rem",
    title: "C · Agent bubble",
  },
  bar: {
    blurb:
      "A status bar attached to the stage's bottom edge instead of floating. Status on the left, controls on the right; a narrow stage splits it into two rows.",
    Dock: EdgeBarDock,
    reserve: "3rem",
    title: "D · Edge bar",
  },
} as const satisfies Record<string, DockVariant>;

export type VariantId = keyof typeof variants;
