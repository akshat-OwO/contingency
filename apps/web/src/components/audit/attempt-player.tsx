import type { RunSnapshot } from "@contingency/protocol";
import { FilmIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import {
  seekSeconds,
  videoSegment,
} from "@/components/audit/audit-workspace-state";
import { Spinner } from "@/components/ui/spinner";

const videoSource = (runId: string, attempt: number): string =>
  `/runs/${encodeURIComponent(runId)}/video/${attempt}`;

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
  readonly run: RunSnapshot;
  readonly stepIndex: number | undefined;
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
  run,
  stepIndex,
}: AttemptPlayerProps) => {
  const video = useRef<HTMLVideoElement>(null);
  const segment = videoSegment(run, attempt);
  const seek = seekSeconds(segment, stepIndex);

  useEffect(() => {
    const element = video.current;
    if (element === null || seek === undefined) {
      return;
    }
    // Seeking before metadata lands is dropped, so the seek is repeated once
    // the duration is known.
    const apply = () => {
      element.currentTime = seek;
    };
    if (element.readyState !== 0) {
      apply();
    }
    // Armed regardless: a seek issued before metadata lands is dropped, and
    // this repeats it once the duration is known.
    element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [seek]);

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
    <div className={className}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Derived frames of a Run carry no audio track to caption. */}
      <video
        className="h-full w-full bg-black object-contain"
        controls
        key={`${run.run.runId}-${segment.attempt}`}
        preload="metadata"
        ref={video}
        src={videoSource(run.run.runId, segment.attempt)}
      >
        Your browser cannot play this Run's derived video.
      </video>
    </div>
  );
};
