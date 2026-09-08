import { playheadAtSeconds } from "@contingency/protocol";
import type { RunVideoSegment, VideoFrameTarget } from "@contingency/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import {
  formatTimecode,
  seekSeconds,
  segmentDuration,
} from "@/components/audit/audit-workspace-state";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface FramePlayerProps {
  readonly onPin: (target: VideoFrameTarget) => void;
  readonly segment: RunVideoSegment;
  readonly selected: VideoFrameTarget | undefined;
  readonly src: string;
  readonly timeline: readonly TimelineStep[];
}

const sameFrame = (left: VideoFrameTarget, right: VideoFrameTarget): boolean =>
  left.kind === "settled"
    ? right.kind === "settled"
    : right.kind === "step" && right.index === left.index;

const pinControlLabel = (
  direction: "Next" | "Previous",
  target: VideoFrameTarget | undefined
): string =>
  target?.kind === "settled"
    ? `${direction}: Run settled`
    : `${direction} Step`;

const framePins = (segment: RunVideoSegment): readonly VideoFrameTarget[] => [
  ...segment.steps.map((index) => ({ index, kind: "step" as const })),
  ...(segment.includesSettledState ? [{ kind: "settled" as const }] : []),
];

const SettledMarker = ({
  duration,
  onPin,
  segment,
  selected,
}: {
  readonly duration: number;
  readonly onPin: (target: VideoFrameTarget) => void;
  readonly segment: RunVideoSegment;
  readonly selected: VideoFrameTarget | undefined;
}) => {
  const at = seekSeconds(segment, { kind: "settled" });
  if (at === undefined || duration === 0 || !segment.includesSettledState) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Run settled"
        className={cn(
          "pointer-events-auto absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400/80",
          selected?.kind === "settled" && "ring-primary size-2 ring-2"
        )}
        onClick={() => onPin({ kind: "settled" })}
        render={<button type="button" />}
        style={{ left: `${(at / duration) * 100}%` }}
      />
      <TooltipContent>Run settled</TooltipContent>
    </Tooltip>
  );
};

const StepMarkers = ({
  duration,
  onPin,
  segment,
  selected,
  timeline,
}: {
  readonly duration: number;
  readonly onPin: (target: VideoFrameTarget) => void;
  readonly segment: RunVideoSegment;
  readonly selected: VideoFrameTarget | undefined;
  readonly timeline: readonly TimelineStep[];
}) => (
  <div className="pointer-events-none absolute inset-x-0 top-0 h-1">
    {segment.steps.map((stepIndex) => {
      const at = seekSeconds(segment, { index: stepIndex, kind: "step" });
      if (at === undefined || duration === 0) {
        return null;
      }
      const step = timeline.find(({ index }) => index === stepIndex);
      const active = selected?.kind === "step" && selected.index === stepIndex;
      return (
        <Tooltip key={stepIndex}>
          <TooltipTrigger
            aria-label={`Step ${stepIndex}${step === undefined ? "" : `: ${step.label}`}`}
            className={cn(
              "pointer-events-auto absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
              step?.result?.outcome === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground/60",
              active && "ring-primary size-2 ring-2"
            )}
            onClick={() => onPin({ index: stepIndex, kind: "step" })}
            render={<button type="button" />}
            style={{ left: `${(at / duration) * 100}%` }}
          />
          <TooltipContent>
            Step {stepIndex} · {step?.label ?? "this Step"}
          </TooltipContent>
        </Tooltip>
      );
    })}
    <SettledMarker
      duration={duration}
      onPin={onPin}
      segment={segment}
      selected={selected}
    />
  </div>
);

/**
 * The player for a Run's derived frames. Built out of the design system rather
 * than the browser's own controls: what is being scrubbed is a Step timeline,
 * not a recording, so the transport carries a marker per Step and moves in
 * whole frames. Free scrubbing and playing stay available and do not change
 * which frame is pinned — only a frame control does
 * ([ADR 0023](../../../../docs/adr/0023-audit-view-starts-runs.md)).
 */
export const FramePlayer = ({
  onPin,
  segment,
  selected,
  src,
  timeline,
}: FramePlayerProps) => {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [failed, setFailed] = useState(false);
  const seek = seekSeconds(segment, selected);
  // The segment's own length, which is known before the file loads: one frame
  // per executed Step, plus the settled state when capture produced one. The
  // element's `duration` only confirms it.
  const duration = segmentDuration(segment);
  const pins = framePins(segment);

  const current =
    selected !== undefined &&
    (selected.kind === "settled" ||
      pins.some((pin) => sameFrame(pin, selected)))
      ? selected
      : playheadAtSeconds(segment, currentTime);
  const position =
    current === undefined
      ? -1
      : pins.findIndex((pin) => sameFrame(pin, current));
  const previous = position > 0 ? pins[position - 1] : undefined;
  const next =
    position !== -1 && position < pins.length - 1
      ? pins[position + 1]
      : undefined;

  useEffect(() => {
    const element = video.current;
    // Nothing to seek to is nothing to wait for: `apply` becomes a no-op and
    // the listener is attached and removed all the same, so this effect has
    // exactly one exit and never leaves one behind.
    let landed = element === null || seek === undefined;
    const apply = () => {
      // Once the seek has been honoured this stops firing. It pauses, and a
      // readiness event fires during playback too: without the guard, playing
      // the segment would snap back to the pinned Step and stop.
      if (landed || element === null || seek === undefined) {
        return;
      }
      // Choosing a Step is asking to look at its frame, so playback stops on
      // it rather than running on past what was asked for.
      element.pause();
      element.currentTime = seek;
      // A seek against a resource that cannot yet honour one is dropped on
      // the floor and fires no `seeked`, so the only way to know it took is
      // to ask whether the resource was seekable when it was issued.
      landed = (element.seekable?.length ?? 0) > 0;
    };
    apply();
    // Repeated once the file can play, for a seek issued before it loaded: a
    // seek against a resource that is not yet seekable is simply dropped.
    element?.addEventListener("canplay", apply);
    return () => element?.removeEventListener("canplay", apply);
  }, [seek]);

  const onScrub = (value: number) => {
    const element = video.current;
    if (element !== null) {
      element.currentTime = value;
    }
    setCurrentTime(value);
  };

  const onToggle = () => {
    const element = video.current;
    if (element === null) {
      return;
    }
    if (element.paused) {
      void element.play();
      return;
    }
    element.pause();
  };

  const stepTo = (target: VideoFrameTarget | undefined) => {
    if (target !== undefined) {
      onPin(target);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepTo(next);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepTo(previous);
    }
  };

  const over = playheadAtSeconds(segment, currentTime);
  let playheadLabel = "No frame";
  if (over?.kind === "step") {
    playheadLabel = `Step ${over.index} of ${segment.steps.length} frames`;
  } else if (over?.kind === "settled") {
    playheadLabel = "Run settled";
  }

  return (
    <div
      aria-label="Derived frames"
      className="flex h-full min-h-0 flex-col bg-black"
      onKeyDown={onKeyDown}
      role="region"
      tabIndex={0}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Derived frames of a Run carry no audio track to caption. */}
      <video
        className="min-h-0 w-full flex-1 object-contain"
        onError={() => setFailed(true)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        preload="auto"
        ref={video}
        src={src}
      />

      {failed && (
        <p className="flex items-center justify-center gap-2 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500">
          <TriangleAlertIcon className="size-3.5" />
          This attempt's video could not be loaded from {src}.
        </p>
      )}

      {segment.error !== undefined && (
        <p className="flex items-center justify-center gap-2 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500">
          <TriangleAlertIcon className="size-3.5" />
          {segment.error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-white/10 px-2 py-1.5 text-white">
        <Button
          aria-label={playing ? "Pause" : "Play"}
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={onToggle}
          size="icon-sm"
          variant="ghost"
        >
          {playing ? (
            <PauseIcon className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
        </Button>
        <Button
          aria-label={pinControlLabel("Previous", previous)}
          className="text-white hover:bg-white/10 hover:text-white"
          disabled={previous === undefined}
          onClick={() => stepTo(previous)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={pinControlLabel("Next", next)}
          className="text-white hover:bg-white/10 hover:text-white"
          disabled={next === undefined}
          onClick={() => stepTo(next)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>

        <span className="font-mono text-xs tabular-nums">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>

        <div className="relative mx-2 flex-1">
          <Slider
            aria-label="Scrub the derived frames"
            max={duration}
            min={0}
            onValueChange={(value) =>
              onScrub(Array.isArray(value) ? (value[0] ?? 0) : value)
            }
            step={0.1}
            value={Math.min(currentTime, duration)}
          />
          <StepMarkers
            duration={duration}
            onPin={onPin}
            segment={segment}
            selected={selected}
            timeline={timeline}
          />
        </div>

        <span className="text-xs whitespace-nowrap text-white/70">
          {playheadLabel}
        </span>
      </div>
    </div>
  );
};
