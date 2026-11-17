import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { NotebookTextIcon, PanelRightCloseIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useState } from "react";
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

/** Drops the morph's names once the transition has run, however it ends. */
const clearMorphWhenDone = async (transition: ViewTransition) => {
  try {
    await transition.finished;
  } finally {
    delete document.documentElement.dataset.runSummaryMorph;
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
  root.dataset.runSummaryMorph = "";
  const transition = document.startViewTransition(() => {
    flushSync(update);
  });
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
      aria-expanded={false}
      aria-label={`Expand ${dock.label}`}
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
}: {
  readonly children: ReactNode;
  /** Names the dock for assistive technology and its controls. */
  readonly label: string;
  /** The summary to show, or `null` for a full-width Workspace. */
  readonly summary: ReactNode | null;
}) => {
  const [collapsedAtom] = useState(() => Atom.make(false));
  const [collapsed, setCollapsed] = useAtom(collapsedAtom);
  const [verdictAtom] = useState(() => Atom.make<SummaryVerdict | null>(null));
  const [verdict, setVerdict] = useAtom(verdictAtom);
  const present = summary !== null;
  // A new summary opens again, even if the last one was folded away.
  useEffect(() => {
    if (!present) {
      setCollapsed(false);
    }
  }, [present, setCollapsed]);
  const expand = () => {
    morphDock(() => {
      setCollapsed(false);
    });
  };
  const dock: RunSummaryDockState | null = present
    ? { collapsed, expand, label, verdict }
    : null;
  const open = present && !collapsed;
  return (
    <RunSummaryDockContext.Provider value={dock}>
      <PublishVerdictContext.Provider value={setVerdict}>
        <div
          className="relative flex min-h-0 flex-1 flex-col [--run-summary-width:22.5rem] xl:[--run-summary-width:26.25rem]"
          data-run-summary={open ? "open" : undefined}
        >
          {children}
          {present ? (
            // Collapsed, the summary stays mounted so its video and tab keep
            // their place; only the island is hidden.
            <div className="contents" hidden={collapsed}>
              <RunSummaryDock
                label={label}
                onCollapse={() => {
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
