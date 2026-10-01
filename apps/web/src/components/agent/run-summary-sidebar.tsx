import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
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

/** The rail a collapsed sidebar keeps, wide enough for its expand button. */
const COLLAPSED_SIZE = "3rem";

const RunSummarySidebar = ({
  children,
  label,
  mobile,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly mobile: boolean;
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
        minSize={mobile ? "12rem" : "20rem"}
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
          className="bg-background animate-in slide-in-from-right flex h-full min-w-0 flex-col duration-200 motion-reduce:animate-none"
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
 * The live Workspace with, when there is one, a Run Summary docked to its
 * right. The summary takes its width from the Workspace rather than floating
 * over it, so the browser, its notices, and the dock all centre in what is
 * left and nothing ends up underneath the dock (#296).
 *
 * The Workspace panel is always rendered in the same place, so a summary
 * arriving or leaving never remounts the live browser canvas.
 */
export const WorkspaceWithRunSummary = ({
  children,
  label,
  summary,
}: {
  readonly children: ReactNode;
  /** Names the sidebar for assistive technology and its controls. */
  readonly label: string;
  /** The summary to show, or `null` for a full-width Workspace. */
  readonly summary: ReactNode | null;
}) => {
  const mobile = useIsMobile();
  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1"
      orientation={mobile ? "vertical" : "horizontal"}
    >
      <ResizablePanel
        className="flex min-h-0 flex-col"
        id="workspace"
        minSize={mobile ? "12rem" : "20rem"}
        style={{ overflow: "hidden" }}
      >
        {children}
      </ResizablePanel>
      {summary === null ? null : (
        <RunSummarySidebar label={label} mobile={mobile}>
          {summary}
        </RunSummarySidebar>
      )}
    </ResizablePanelGroup>
  );
};
