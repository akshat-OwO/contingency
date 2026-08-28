import type { RunVideoSegment } from "@contingency/protocol";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import {
  frameStepIndex,
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

/** `m:ss.d` — a slideshow is half a second per frame, so tenths matter. */
export const formatTimecode = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
};

export interface FramePlayerProps {
  readonly onPinStep: (index: number) => void;
  readonly segment: RunVideoSegment;
  readonly selected: number | undefined;
  readonly src: string;
  readonly timeline: readonly TimelineStep[];
}

const StepMarkers = ({
  duration,
  onPinStep,
  segment,
  selected,
  timeline,
}: {
  readonly duration: number;
  readonly onPinStep: (index: number) => void;
  readonly segment: RunVideoSegment;
  readonly selected: number | undefined;
  readonly timeline: readonly TimelineStep[];
}) => (
  <div className="pointer-events-none absolute inset-x-0 top-0 h-1">
    {segment.steps.map((stepIndex) => {
      const at = seekSeconds(segment, stepIndex);
      if (at === undefined || duration === 0) {
        return null;
      }
      const step = timeline.find(({ index }) => index === stepIndex);
      return (
        <Tooltip key={stepIndex}>
          <TooltipTrigger
            aria-label={`Step ${stepIndex}${step === undefined ? "" : `: ${step.label}`}`}
            className={cn(
              "pointer-events-auto absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
              step?.result?.outcome === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground/60",
              stepIndex === selected && "ring-primary size-2 ring-2"
            )}
            onClick={() => onPinStep(stepIndex)}
            render={<button type="button" />}
            style={{ left: `${(at / duration) * 100}%` }}
          />
          <TooltipContent>
            Step {stepIndex} · {step?.label ?? "this Step"}
          </TooltipContent>
        </Tooltip>
      );
    })}
  </div>
);

/**
 * The player for a Run's derived frames. Built out of the design system rather
 * than the browser's own controls: what is being scrubbed is a Step timeline,
 * not a recording, so the transport carries a marker per Step and moves in
 * whole Steps. Free scrubbing and playing stay available and do not change
 * which Step is pinned — only a Step control does
 * ([ADR 0023](../../../../docs/adr/0023-audit-view-starts-runs.md)).
 */
export const FramePlayer = ({
  onPinStep,
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
  // per executed Step. The element's `duration` only confirms it.
  const duration = segmentDuration(segment);

  const recorded = useMemo(
    () => [...segment.steps].toSorted((left, right) => left - right),
    [segment.steps]
  );
  const position = selected === undefined ? -1 : recorded.indexOf(selected);
  const previous = position > 0 ? recorded[position - 1] : undefined;
  const next =
    position >= 0 && position < recorded.length - 1
      ? recorded[position + 1]
      : undefined;

  useEffect(() => {
    const element = video.current;
    if (element === null || seek === undefined) {
      return;
    }
    const apply = () => {
      // Choosing a Step is asking to look at its frame, so playback stops on
      // it rather than running on past what was asked for.
      element.pause();
      element.currentTime = seek;
    };
    apply();
    // A seek issued before the file is seekable is dropped on the floor, so
    // it is repeated as the element reaches each readiness that can honour
    // it. `seeked` never fires for a dropped seek, so this cannot rely on it.
    const events = ["loadedmetadata", "loadeddata", "canplay"] as const;
    for (const event of events) {
      element.addEventListener(event, apply);
    }
    return () => {
      for (const event of events) {
        element.removeEventListener(event, apply);
      }
    };
  }, [seek]);

  const onScrub = useCallback((value: number) => {
    const element = video.current;
    if (element !== null) {
      element.currentTime = value;
    }
    setCurrentTime(value);
  }, []);

  const onToggle = useCallback(() => {
    const element = video.current;
    if (element === null) {
      return;
    }
    if (element.paused) {
      void element.play();
      return;
    }
    element.pause();
  }, []);

  const over = frameStepIndex(segment, currentTime);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
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
          aria-label="Previous Step"
          className="text-white hover:bg-white/10 hover:text-white"
          disabled={previous === undefined}
          onClick={() => previous !== undefined && onPinStep(previous)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Next Step"
          className="text-white hover:bg-white/10 hover:text-white"
          disabled={next === undefined}
          onClick={() => next !== undefined && onPinStep(next)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>

        <span className="font-mono text-[11px] tabular-nums">
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
            onPinStep={onPinStep}
            segment={segment}
            selected={selected}
            timeline={timeline}
          />
        </div>

        <span className="text-[11px] whitespace-nowrap text-white/70">
          {over === undefined
            ? "No frame"
            : `Step ${over} of ${recorded.length} frames`}
        </span>
      </div>
    </div>
  );
};
