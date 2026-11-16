import { WatcherMark } from "@/components/brand";
import { cn } from "@/lib/utils";

import { useWorkspaceHome } from "./workspace-home-context";

/**
 * The watcher mark as a link to the Workspace home, named **Contingency
 * home**. Every session dock and every native screen without a dock carries
 * it, on all three platforms. The mark is the one the home's wordmark morphs
 * into.
 */
export const WorkspaceHomeLink = ({
  className,
}: {
  readonly className?: string;
}) => {
  const home = useWorkspaceHome();
  return (
    // oxlint-disable-next-line react-doctor/no-prevent-default -- goHome navigates through the router inside a View Transition.
    <a
      aria-label="Contingency home"
      className={cn(
        "hover:bg-muted focus-visible:ring-ring inline-flex h-7 shrink-0 items-center rounded-md px-1.5 outline-none focus-visible:ring-2",
        className
      )}
      href="/"
      onClick={(event) => {
        if (
          home === null ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        home.goHome();
      }}
      title="Contingency home"
    >
      <WatcherMark data-vt="brand-mark" />
    </a>
  );
};

/**
 * The way home floating at the top left of a native screen that has no dock
 * yet: the empty platform, a session being prepared, and an unlisted iOS.
 */
export const WorkspaceHomeBar = () => (
  <div className="pointer-events-none absolute top-2 left-2 z-20 flex">
    <WorkspaceHomeLink className="material-float pointer-events-auto h-9 rounded-xl px-2.5 shadow-sm" />
  </div>
);
