import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { PanelRightCloseIcon, PanelRightOpenIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { usePanelRef } from "react-resizable-panels";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import type { PresenceMotion } from "@/hooks/use-presence";
import { usePresence } from "@/hooks/use-presence";

/**
 * A sidebar slides in from the edge it docks to and leaves the same way. On a
 * narrow screen the group stacks vertically, so the summary docks below the
 * Workspace and the leading panel above it.
 */
const slideFrom = (
  edge: "bottom" | "left" | "right" | "top"
): PresenceMotion => {
  const offset = {
    bottom: "translateY(100%)",
    left: "translateX(-100%)",
    right: "translateX(100%)",
    top: "translateY(-100%)",
  }[edge];
  return {
    durationMs: 240,
    hidden: { transform: offset },
    shown: { transform: "translate(0, 0)" },
  };
};

/** The rail a collapsed sidebar keeps, wide enough for its expand button. */
const COLLAPSED_SIZE = "3rem";

const RunSummarySidebar = ({
  asideRef,
  children,
  label,
  leaving,
  mobile,
  minimumSize,
  onClose,
}: {
  readonly asideRef: (element: HTMLElement | null) => void;
  readonly children: ReactNode;
  readonly label: string;
  /** Animating out; it takes no input while it goes. */
  readonly leaving: boolean;
  readonly mobile: boolean;
  readonly minimumSize: string;
  /** Closes rather than collapses, for content the user opened themselves. */
  readonly onClose: (() => void) | undefined;
}) => {
  const panelRef = usePanelRef();
  const contentId = useId();
  const [collapsedAtom] = useState(() => Atom.make(false));
  const [collapsed, setCollapsed] = useAtom(collapsedAtom);
  return (
    <>
      <ResizableHandle aria-label={`Resize ${label}`} withHandle />
      <ResizablePanel
        collapsedSize={COLLAPSED_SIZE}
        collapsible
        defaultSize={mobile ? "45%" : "30rem"}
        groupResizeBehavior="preserve-pixel-size"
        id="run-summary"
        maxSize={mobile ? "65%" : "48rem"}
        minSize={minimumSize}
        onResize={() => {
          setCollapsed(panelRef.current?.isCollapsed() ?? false);
        }}
        panelRef={panelRef}
        style={{ overflow: "hidden" }}
      >
        {/*
          The summary slides in from the edge it docks to. The panel already
          holds its width, so only the content moves and the Workspace settles
          once rather than following the animation.
        */}
        <aside
          aria-label={label}
          className="bg-background flex h-full min-w-0 flex-col"
          inert={leaving}
          ref={asideRef}
        >
          {collapsed ? (
            <div className="flex justify-center p-2">
              <Button
                aria-expanded={false}
                aria-label={`Expand ${label}`}
                onClick={() => {
                  panelRef.current?.expand();
                }}
                size="icon-sm"
                variant="ghost"
              >
                <PanelRightOpenIcon aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                <p className="truncate text-sm font-semibold">{label}</p>
                {onClose === undefined ? (
                  <Button
                    aria-controls={contentId}
                    aria-expanded
                    aria-label={`Collapse ${label}`}
                    onClick={() => {
                      panelRef.current?.collapse();
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <PanelRightCloseIcon aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    aria-label={`Close ${label}`}
                    onClick={onClose}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                )}
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto p-4"
                id={contentId}
              >
                {children}
              </div>
            </>
          )}
        </aside>
      </ResizablePanel>
    </>
  );
};

/**
 * A panel the user opened from the dock, docked to the Workspace's left. Like
 * the summary, it takes its width from the Workspace rather than covering it,
 * and it slides in from the edge it docks to.
 */
const LeadingSidebar = ({
  asideRef,
  children,
  label,
  leaving,
  mobile,
  minimumSize,
  onClose,
}: {
  readonly asideRef: (element: HTMLElement | null) => void;
  readonly children: ReactNode;
  readonly label: string;
  readonly leaving: boolean;
  readonly mobile: boolean;
  readonly minimumSize: string;
  readonly onClose: () => void;
}) => (
  <>
    <ResizablePanel
      defaultSize={mobile ? "45%" : "34rem"}
      groupResizeBehavior="preserve-pixel-size"
      id="workspace-leading"
      maxSize={mobile ? "65%" : "50rem"}
      minSize={minimumSize}
      style={{ overflow: "hidden" }}
    >
      <aside
        aria-label={label}
        className="bg-background flex h-full min-w-0 flex-col"
        inert={leaving}
        ref={asideRef}
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <p className="truncate text-sm font-semibold">{label}</p>
          <Button
            aria-label={`Close ${label}`}
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </aside>
    </ResizablePanel>
    <ResizableHandle aria-label={`Resize ${label}`} withHandle />
  </>
);

/** A dock-opened panel on the Workspace's left. */
export interface WorkspaceLeading {
  readonly content: ReactNode;
  readonly label: string;
  readonly onClose: () => void;
}

/**
 * The live Workspace with, when there is one, a Run Summary docked to its
 * right. The summary takes its width from the Workspace rather than floating
 * over it, so the browser, its notices, and the dock all centre in what is
 * left and nothing ends up underneath the dock (#296).
 *
 * The Workspace panel is always rendered in the same place, so a summary
 * arriving or leaving never remounts the live browser canvas. The Skills
 * drawer docks to the left the same way.
 */
export const WorkspaceWithRunSummary = ({
  children,
  label,
  leading = null,
  onCloseSummary,
  summary,
}: {
  readonly children: ReactNode;
  /** Names the sidebar for assistive technology and its controls. */
  readonly label: string;
  /** A panel on the Workspace's left, or `null` for none. */
  readonly leading?: WorkspaceLeading | null;
  /** Makes the right panel closable rather than collapsible. */
  readonly onCloseSummary?: (() => void) | undefined;
  /** The summary to show, or `null` for a full-width Workspace. */
  readonly summary: ReactNode | null;
}) => {
  const mobile = useIsMobile();
  // A closed sidebar keeps its panel while it slides out, then the Workspace
  // takes the width back in one step, as it gave it up on arrival.
  const leadingPresence = usePresence(
    leading ?? undefined,
    slideFrom(mobile ? "top" : "left")
  );
  const summaryPresence = usePresence(
    summary ?? undefined,
    slideFrom(mobile ? "bottom" : "right")
  );
  const shownLeading = leadingPresence.rendered;
  const shownSummary = summaryPresence.rendered;
  // Skills, Workspace, and Details must fit together even with enlarged
  // text. Three root-relative minima can otherwise force Details closed.
  const sharingSpace = shownLeading !== undefined && shownSummary !== undefined;
  const leadingMinimum = mobile ? "12rem" : "24rem";
  const summaryMinimum = mobile ? "12rem" : "20rem";
  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={mobile ? "vertical" : "horizontal"}
    >
      {shownLeading === undefined ? null : (
        <LeadingSidebar
          asideRef={leadingPresence.ref}
          label={shownLeading.label}
          leaving={leadingPresence.leaving}
          mobile={mobile}
          minimumSize={sharingSpace ? "20%" : leadingMinimum}
          onClose={shownLeading.onClose}
        >
          {shownLeading.content}
        </LeadingSidebar>
      )}
      <ResizablePanel
        className="flex min-h-0 flex-col"
        id="workspace"
        minSize={sharingSpace ? "20%" : summaryMinimum}
        style={{ overflow: "hidden" }}
      >
        {children}
      </ResizablePanel>
      {shownSummary === undefined ? null : (
        <RunSummarySidebar
          asideRef={summaryPresence.ref}
          label={label}
          leaving={summaryPresence.leaving}
          mobile={mobile}
          minimumSize={sharingSpace ? "20%" : summaryMinimum}
          onClose={onCloseSummary}
        >
          {shownSummary}
        </RunSummarySidebar>
      )}
    </ResizablePanelGroup>
  );
};
