import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { NotebookTextIcon, PanelRightCloseIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import type { SummaryVerdict } from "@/components/agent/dry-run-summary-state";
import { VerdictChip } from "@/components/agent/run-summary-verdict";
import { Button } from "@/components/ui/button";
import { canViewTransition } from "@/lib/view-transition";

/** What the status island needs to fold the summary into a pill. */
interface RunSummaryDockState {
  readonly collapsed: boolean;
  readonly expand: () => void;
  readonly label: string;
  readonly verdict: SummaryVerdict | null;
}

const RunSummaryDockContext = createContext<RunSummaryDockState | null>(null);

const PublishVerdictContext = createContext<
  ((verdict: SummaryVerdict | null) => void) | null
>(null);

/**
 * Lets the summary inside the dock name its verdict, so the collapsed pill in
 * the status island keeps it in view. Outside a dock it does nothing.
 */
export const usePublishRunSummaryVerdict = (verdict: SummaryVerdict): void => {
  const publish = useContext(PublishVerdictContext);
  const { label, tone } = verdict;
  useEffect(() => {
    if (publish === null) {
      return;
    }
    publish({ label, tone });
    return () => {
      publish(null);
    };
  }, [label, publish, tone]);
};

/**
 * Whether the docked summary is folded into its pill. Anything the summary
 * holds, such as its Flow decision, is out of reach until it opens again.
 */
export const useRunSummaryCollapsed = (): boolean =>
  useContext(RunSummaryDockContext)?.collapsed ?? false;

/** The morph still running, if any; a newer one replaces it. */
let currentMorph: ViewTransition | undefined;

/**
 * Drops the morph's names once the transition has run, however it ends. A
 * morph a newer one skipped leaves them to the newer one.
 */
const clearMorphWhenDone = async (transition: ViewTransition) => {
  try {
    await transition.finished;
  } catch {
    // The update itself threw; React reports that. The names still go.
  } finally {
    if (currentMorph === transition) {
      currentMorph = undefined;
      delete document.documentElement.dataset.runSummaryMorph;
    }
  }
};

/**
 * The collapse and expand morph: the dock and the pill share a View
 * Transition name only while one becomes the other, so navigating away never
 * animates the dock on its own.
 */
const morphDock = (update: () => void) => {
  if (!canViewTransition()) {
    update();
    return;
  }
  const root = document.documentElement;
  // A morph during the entrance cancels it, and the dock is in place from
  // here on, so its entrance counts as played.
  for (const dock of root.querySelectorAll<HTMLElement>(
    '[data-slot="run-summary-dock"]'
  )) {
    dock.dataset.entered = "";
  }
  root.dataset.runSummaryMorph = "";
  const transition = document.startViewTransition(() => {
    flushSync(update);
  });
  currentMorph = transition;
  void clearMorphWhenDone(transition);
};

/**
 * The collapsed Run Summary: a tool in the status island that keeps the
 * verdict in view and opens the dock again. Nothing is left floating over the
 * canvas.
 */
export const RunSummaryPill = () => {
  const dock = useContext(RunSummaryDockContext);
  if (dock === null || !dock.collapsed) {
    return null;
  }
  return (
    <Button
      size="md"
      aria-expanded={false}
      // The name keeps the visible text, so the verdict is read out too.
      aria-label={
        dock.verdict === null
          ? `Expand ${dock.label}`
          : `Expand ${dock.label}: Summary ${dock.verdict.label}`
      }
      className="gap-1.5 pr-1.5"
      data-run-summary-pill=""
      onClick={dock.expand}
      type="button"
      variant="ghost"
    >
      <NotebookTextIcon aria-hidden="true" />
      Summary
      {dock.verdict === null ? null : <VerdictChip verdict={dock.verdict} />}
    </Button>
  );
};

/** Marks the dock's entrance as played, once its own animation ends. */
const markEntered = (event: React.AnimationEvent<HTMLElement>) => {
  if (event.target === event.currentTarget) {
    event.currentTarget.dataset.entered = "";
  }
};

/**
 * The floating island an ended Run's summary docks in, on the right of the
 * stage and under the top islands. The stage gives up the dock's width rather
 * than sitting under it, so the frame, its notices, and the status island all
 * centre in what is left (#296, #757). Collapsing folds it into the status
 * island as a `RunSummaryPill`.
 */
const RunSummaryDock = ({
  children,
  label,
  onCollapse,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onCollapse: () => void;
}) => {
  const bodyId = useId();
  const headingId = useId();
  return (
    <aside
      aria-labelledby={headingId}
      // The entrance plays once. After a morph the dock is already in place,
      // so it must not slide in again when the morph's names are dropped.
      onAnimationEnd={markEntered}
      className="island animate-in fade-in slide-in-from-right-6 absolute top-[4.25rem] right-3 bottom-3 z-30 flex min-h-0 w-(--run-summary-width) flex-col overflow-hidden duration-500 ease-out motion-reduce:animate-none"
      data-slot="run-summary-dock"
    >
      <header className="border-island-border flex items-center gap-2 border-b py-2 pr-2 pl-3.5">
        <NotebookTextIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <h2
          className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]"
          id={headingId}
        >
          {label}
        </h2>
        <Button
          aria-controls={bodyId}
          aria-expanded
          aria-label={`Collapse ${label}`}
          data-run-summary-collapse=""
          onClick={onCollapse}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <PanelRightCloseIcon aria-hidden="true" />
        </Button>
      </header>
      <div
        className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-y-auto px-4 pt-3.5 pb-4"
        id={bodyId}
      >
        {children}
      </div>
    </aside>
  );
};

/**
 * The Workspace with, when there is one, an ended Run's summary docked to its
 * right. The children always render in the same place, so a summary arriving
 * or leaving never remounts the live canvas. While the dock is open the stage
 * gives up its width through `--run-summary-inset`; the top islands keep the
 * full width.
 */
export const WorkspaceWithRunSummary = ({
  children,
  label,
  summary,
  summaryKey,
}: {
  readonly children: ReactNode;
  /** Names the dock for assistive technology and its controls. */
  readonly label: string;
  /** The summary to show, or `null` for a full-width Workspace. */
  readonly summary: ReactNode | null;
  /**
   * Which Run the summary belongs to. A different one opens the dock again,
   * even when one ended session follows another directly.
   */
  readonly summaryKey?: string | undefined;
}) => {
  const [collapsedAtom] = useState(() => Atom.make(false));
  const [collapsed, setCollapsed] = useAtom(collapsedAtom);
  const [verdictAtom] = useState(() => Atom.make<SummaryVerdict | null>(null));
  const [verdict, setVerdict] = useAtom(verdictAtom);
  const present = summary !== null;
  const containerRef = useRef<HTMLDivElement>(null);
  // Where focus goes once a collapse or expand the user asked for lands.
  const focusAfterRef = useRef<"dock" | "pill" | null>(null);
  // A new summary opens again, even if the last one was folded away.
  useEffect(() => {
    if (!present) {
      setCollapsed(false);
    }
  }, [present, setCollapsed]);
  // Another Run's summary opens too, even straight after this one.
  useEffect(() => {
    setCollapsed(false);
  }, [summaryKey, setCollapsed]);
  // The control that hid itself had focus; hand it to the one that replaced
  // it, so keyboard and screen reader users are not dropped to the page.
  useEffect(() => {
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === null) {
      return;
    }
    containerRef.current
      ?.querySelector<HTMLElement>(
        target === "pill"
          ? "[data-run-summary-pill]"
          : "[data-run-summary-collapse]"
      )
      ?.focus();
  }, [collapsed]);
  const open = present && !collapsed;
  // On a phone the open dock covers the stage, so what it covers leaves the
  // tab order until it collapses. The top islands stay in reach.
  useEffect(() => {
    const container = containerRef.current;
    // jsdom and older engines have no `matchMedia`; the dock then stays
    // inset as on a wide screen.
    const narrow = globalThis.matchMedia?.("(width < 48rem)");
    if (!open || container === null || narrow === undefined) {
      return;
    }
    let covered: HTMLElement[] = [];
    const release = () => {
      for (const element of covered) {
        element.removeAttribute("inert");
      }
      covered = [];
    };
    const apply = () => {
      release();
      if (!narrow.matches) {
        return;
      }
      covered = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-vt="stage"] > :not([data-slot="session-top-bar"])'
        ),
      ];
      for (const element of covered) {
        element.setAttribute("inert", "");
      }
    };
    apply();
    narrow.addEventListener("change", apply);
    return () => {
      narrow.removeEventListener("change", apply);
      release();
    };
  }, [open]);
  const expand = () => {
    focusAfterRef.current = "dock";
    morphDock(() => {
      setCollapsed(false);
    });
  };
  const dock: RunSummaryDockState | null = present
    ? { collapsed, expand, label, verdict }
    : null;
  return (
    <RunSummaryDockContext.Provider value={dock}>
      <PublishVerdictContext.Provider value={setVerdict}>
        {/*
         * The Workspace fills its container whether or not the parent is a
         * flex column: the iOS Workspace mounts it straight under the block
         * root, where `flex-1` alone left the stage its padding's height and
         * the device frame no height at all (#740).
         */}
        <div
          className="relative flex h-full min-h-0 flex-1 flex-col [--run-summary-width:22.5rem] max-md:[--run-summary-width:calc(100%-1.5rem)] xl:[--run-summary-width:26.25rem]"
          data-run-summary={open ? "open" : undefined}
          ref={containerRef}
        >
          {children}
          {present ? (
            // Collapsed, the summary stays mounted so its video and tab keep
            // their place; only the island is hidden.
            <div className="contents" hidden={collapsed}>
              <RunSummaryDock
                label={label}
                onCollapse={() => {
                  focusAfterRef.current = "pill";
                  morphDock(() => {
                    setCollapsed(true);
                  });
                }}
              >
                {summary}
              </RunSummaryDock>
            </div>
          ) : null}
        </div>
      </PublishVerdictContext.Provider>
    </RunSummaryDockContext.Provider>
  );
};
