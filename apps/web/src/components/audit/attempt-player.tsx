import type { RunSnapshot } from "@contingency/protocol";
import { runVideoPath } from "@contingency/protocol";
import { FilmIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import {
  traceSegment,
  videoSegment,
} from "@/components/audit/audit-workspace-state";
import { FramePlayer } from "@/components/audit/frame-player";
import { Spinner } from "@/components/ui/spinner";

const Placeholder = ({
  children,
  icon,
  title,
}: {
  readonly children: React.ReactNode;
  readonly icon: React.ReactNode;
  readonly title: string;
}) => (
  <div className="text-muted-foreground grid h-full place-items-center p-6 text-center">
    <div className="max-w-sm space-y-2">
      <div className="flex justify-center">{icon}</div>
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="text-xs">{children}</p>
    </div>
  </div>
);

export interface AttemptPlayerProps {
  readonly attempt: number | undefined;
  readonly className?: string;
  readonly onPinStep: (index: number) => void;
  readonly run: RunSnapshot;
  readonly stepIndex: number | undefined;
  readonly timeline: readonly TimelineStep[];
}

/**
 * The centre pane. Nothing is shown while the Run executes: a frame does not
 * exist until the Trace stops and its artifacts are prepared, and nothing
 * observes the Runner while it runs
 * ([ADR 0023](../../../../docs/adr/0023-audit-view-starts-runs.md)). What
 * plays afterwards is a slideshow of per-Step screenshots, not motion, so a
 * CSS animation appears in no frame (ADR 0014).
 */
export const AttemptPlayer = ({
  attempt,
  className,
  onPinStep,
  run,
  stepIndex,
  timeline,
}: AttemptPlayerProps) => {
  const segment = videoSegment(run, attempt);
  const trace = traceSegment(run, attempt);

  if (run.phase === "idle") {
    return (
      <div className={className}>
        <Placeholder icon={<PlayIcon className="size-6" />} title="No Run yet">
          Start a Run to execute this Flow and step its frames afterwards.
        </Placeholder>
      </div>
    );
  }

  if (run.phase === "starting" || run.phase === "running") {
    return (
      <div className={className}>
        <Placeholder
          icon={<Spinner className="size-6" />}
          title="Capturing this Run"
        >
          Frames are read back from the Trace once the Run ends. The browser is
          never streamed live, so watching costs the Run nothing.
        </Placeholder>
      </div>
    );
  }

  if (segment === undefined || !segment.recorded) {
    return (
      <div className={className}>
        <Placeholder
          icon={<TriangleAlertIcon className="size-6 text-amber-600" />}
          title="This attempt has no video"
        >
          {segment?.error ??
            "No video was derived for this attempt, so there are no frames to step."}
        </Placeholder>
      </div>
    );
  }

  if (run.run === null) {
    return (
      <div className={className}>
        <Placeholder icon={<FilmIcon className="size-6" />} title="No Run yet">
          There is nothing to play.
        </Placeholder>
      </div>
    );
  }

  return (
    <div className={`${className ?? ""} relative min-h-0`}>
      {/*
        The Trace these frames came from is unredacted and holds full DOM
        snapshots and network payloads, secret Variable values included. Saying
        where it is on disk is fine; it never leaves the machine, and ADR 0020
        forbids referencing a whole Trace from a Handoff.
      */}
      {trace?.recorded === true && (
        <p className="absolute top-1 right-1 z-10 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
          Trace {trace.file} · unredacted, local only
        </p>
      )}
      <FramePlayer
        key={`${run.run.runId}-${segment.attempt}`}
        onPinStep={onPinStep}
        segment={segment}
        selected={stepIndex}
        src={runVideoPath(run.run.runId, segment.attempt)}
        timeline={timeline}
      />
    </div>
  );
};
