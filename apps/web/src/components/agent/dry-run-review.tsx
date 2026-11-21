import { dryRunVideoPath } from "@contingency/protocol";
import type { TeachingRecordingId } from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { MonitorOffIcon } from "lucide-react";

import { RecordingViewer } from "@/components/agent/recording-view";
import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-dock";
import { useRunVideoLastFrame } from "@/components/agent/run-video";
import {
  DockShell,
  DockState,
  DockStatus,
  SessionTopBar,
} from "@/components/agent/workspace-dock";
import { FlowsButton } from "@/components/catalog/flows-button";
import { buttonVariants } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

/**
 * What the Dry Run's browser showed when it ended: the last frame of its
 * video, drawn once the video is ready. Until then, or when there is no
 * video, the stage says where the video is.
 */
const DryRunLastFrame = ({
  recordingId,
}: {
  readonly recordingId: TeachingRecordingId;
}) => {
  const { runVideoStatusAtom } = useRpcDependencies();
  const src = dryRunVideoPath(recordingId);
  const status = useAtomValue(runVideoStatusAtom(src));
  const ready = status._tag === "Success" && status.value.state === "ready";
  const frame = useRunVideoLastFrame(ready ? src : undefined);
  if (frame === undefined) {
    return (
      <p className="text-muted-foreground flex max-w-xs flex-col items-center gap-2 text-center text-[13px] text-pretty">
        <MonitorOffIcon aria-hidden="true" className="size-5" />
        The Dry Run&apos;s browser closed when it ended. Its video is in the
        summary.
      </p>
    );
  }
  return (
    // The stage sits between the top islands and the status island, so the
    // picture keeps clear of both.
    <div className="relative flex max-w-full min-w-0">
      <img
        alt="Last frame of the Dry Run. Its browser closed when it ended."
        className="border-island-border max-h-[calc(100svh-12rem)] max-w-full min-w-0 rounded-[18px] border object-contain shadow-[var(--island-shadow)]"
        src={frame}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-3.5 left-1/2 inline-flex h-[26px] -translate-x-1/2 items-center gap-1.5 rounded-[9px] bg-[oklch(0.18_0_0/0.78)] px-2.5 text-xs font-medium whitespace-nowrap text-[oklch(0.95_0_0)] backdrop-blur-sm"
      >
        <span className="size-1.5 rounded-[1.5px] bg-current" />
        Last frame
      </span>
    </div>
  );
};

/**
 * A Dry Run's review at `?recording=` (ADR 0073), in the same floating
 * layout as an ended session: the top islands, a quiet stage where the
 * browser was, the status island, and the Dry Run Summary docked on the
 * right with the Flow decision under it. The Dry Run's browser is gone, so
 * the stage shows the last frame of its video.
 */
export const DryRunReview = ({
  recordingId,
}: {
  readonly recordingId: TeachingRecordingId;
}) => (
  <div className="workspace-canvas fixed inset-0 flex flex-col">
    <WorkspaceWithRunSummary
      label="Dry Run Summary"
      // Another recording's review opens its dock again, with none of this
      // one's pending decision or error.
      summary={<RecordingViewer key={recordingId} recordingId={recordingId} />}
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
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pt-2 pb-24">
          <DryRunLastFrame recordingId={recordingId} />
        </div>
        <DockShell
          status={
            <DockStatus badges={<DockState>Dry Run review</DockState>}>
              Read-only. Nothing here restarts the Dry Run.
            </DockStatus>
          }
        >
          <Link
            className={buttonVariants({ size: "md", variant: "primary" })}
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
