import type { TeachingRecordingId } from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { MonitorOffIcon } from "lucide-react";
import { useEffect } from "react";

import { workspaceChromeAtom } from "@/components/agent/agent-workspace-state";
import { RecordingViewer } from "@/components/agent/recording-view";
import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-dock";
import {
  DockShell,
  DockState,
  DockStatus,
  SessionTopBar,
} from "@/components/agent/workspace-dock";
import { FlowsButton } from "@/components/catalog/flows-button";
import { buttonVariants } from "@/components/ui/button";

/**
 * A Dry Run's review at `?recording=` (ADR 0073), in the same floating
 * layout as an ended session: the top islands, a quiet stage where the
 * browser was, the status island, and the Dry Run Summary docked on the
 * right with the Flow decision under it. The Dry Run's browser is gone, so
 * the stage says where its video is instead.
 */
export const DryRunReview = ({
  recordingId,
}: {
  readonly recordingId: TeachingRecordingId;
}) => {
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => {
      setChrome(false);
    };
  }, [setChrome]);
  return (
    <div className="workspace-canvas fixed inset-0 flex flex-col">
      <WorkspaceWithRunSummary
        label="Dry Run Summary"
        // Another recording's review opens its dock again, with none of this
        // one's pending decision or error.
        summary={
          <RecordingViewer key={recordingId} recordingId={recordingId} />
        }
        summaryKey={recordingId}
      >
        <main className="relative flex min-h-0 flex-1 flex-col" data-vt="stage">
          <SessionTopBar
            flows={<FlowsButton />}
            picker={
              <h1 className="px-2 text-[13px] font-medium whitespace-nowrap">
                Dry Run review
              </h1>
            }
          />
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-24">
            <p className="text-muted-foreground flex max-w-xs flex-col items-center gap-2 text-center text-[13px] text-pretty">
              <MonitorOffIcon aria-hidden="true" className="size-5" />
              The Dry Run&apos;s browser closed when it ended. Its video is in
              the summary.
            </p>
          </div>
          <DockShell
            status={
              <DockStatus badges={<DockState>Dry Run review</DockState>}>
                Read-only. Nothing here restarts the Dry Run.
              </DockStatus>
            }
          >
            <Link
              className={buttonVariants({ variant: "default" })}
              search={{ run: undefined, session: undefined }}
              to="/"
            >
              Done
            </Link>
          </DockShell>
        </main>
      </WorkspaceWithRunSummary>
    </div>
  );
};
