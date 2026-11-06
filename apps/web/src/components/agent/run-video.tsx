import type {
  AgentTimelineEntry,
  RunVideoTimeMap,
} from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import {
  CheckIcon,
  CopyIcon,
  FileVideoIcon,
  LoaderCircleIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";

import { EvidenceReference } from "@/components/agent/evidence-reference";
import { makeAmbientBlend } from "@/components/agent/run-video-ambient";
import type { AmbientBlend } from "@/components/agent/run-video-ambient";
import { runVideoChapters } from "@/components/agent/run-video-timeline";
import type { RunVideoChapter } from "@/components/agent/run-video-timeline";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

const SKIP_MS = 5000;

/**
 * How far an arrow key moves the focused scrubber: a tenth of a second on a
 * clip under ten seconds, so a short Run is not only its two ends, and one
 * second otherwise. Page keys and the skip buttons keep five seconds.
 */
const scrubStepMs = (durationMs: number): number =>
  durationMs > 0 && durationMs < 10_000 ? 100 : 1000;

/** Seconds to one decimal, for the scrubber's ARIA values. */
const ariaSeconds = (ms: number): number => Math.round(ms / 100) / 10;
const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;
/** One bar per this many pixels of scrubber. */
const BAR_PITCH_PX = 5;
const COPIED_FOR_MS = 1500;
/** How far the hover tip stays from either end of the scrubber. */
const TIP_INSET_PX = 64;

/** A path's last segment. */
const fileName = (path: string) => path.split("/").at(-1) ?? path;

/**
 * A path's last two segments, the Run's folder and its file. A long folder
 * name (a Run id) keeps its readable head; the full path is the title.
 */
const tailOfPath = (path: string) => {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length <= 2) {
    return path;
  }
  const folder = parts.at(-2) ?? "";
  const shown = folder.length > 20 ? `${folder.slice(0, 16)}…` : folder;
  return `…/${shown}/${parts.at(-1) ?? ""}`;
};

// The panel's own focus ring, so the player reads as part of it.
const FOCUS_RING =
  "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none";

/**
 * A time on the player's clock. A recording under ten seconds counts in
 * tenths, so a short one never reads as "0:00" long.
 */
const clock = (ms: number, durationMs = Number.POSITIVE_INFINITY): string => {
  const safe = Math.max(0, ms);
  const seconds = Math.floor(safe / 1000);
  const whole = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return durationMs > 0 && durationMs < 10_000
    ? `${whole}.${Math.floor((safe % 1000) / 100)}`
    : whole;
};

const chapterAt = (
  chapters: readonly RunVideoChapter[],
  ms: number
): RunVideoChapter | undefined =>
  chapters.find(({ fromMs, toMs }) => ms >= fromMs && ms < toMs) ??
  chapters.at(-1);

/** Played bars are solid; the stretch a click would skip to is lifted. */
const barTone = (
  atMs: number,
  currentMs: number,
  hoverMs: number | undefined
): string => {
  if (atMs < currentMs) {
    return "bg-foreground";
  }
  if (hoverMs !== undefined && atMs < hoverMs) {
    return "bg-foreground/60";
  }
  // One step stronger than a hairline, so the bars read on a dark card.
  return "bg-foreground/35";
};

const chapterLineTone = (hovered: boolean, current: boolean): string => {
  if (hovered) {
    return "bg-foreground/80";
  }
  return current ? "bg-foreground/50" : "bg-border";
};

/** Fewer, wider gaps when there are few chapters to tell apart. */
const chapterGapPx = (count: number, barCount: number): number => {
  if (count > barCount) {
    return 0;
  }
  if (count <= 12) {
    return Math.min(6, (barCount * BAR_PITCH_PX) / (2 * count));
  }
  return count <= 40 ? 2 : 1;
};

const ChapterName = ({
  chapter,
  total,
}: {
  readonly chapter: RunVideoChapter;
  readonly total: number;
}) => (
  <>
    {chapter.action === undefined ? null : (
      <span className="text-muted-foreground mr-1 tabular-nums">
        {chapter.action}/{total}
      </span>
    )}
    {chapter.label}
  </>
);

const DockButton = ({
  children,
  label,
  onClick,
  title = label,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onClick: () => Promise<void> | void;
  readonly title?: string;
}) => (
  <Button
    aria-label={label}
    className="text-muted-foreground hover:text-foreground"
    onClick={onClick}
    size="icon-sm"
    title={title}
    type="button"
    variant="ghost"
  >
    {children}
  </Button>
);

/**
 * A circular arrow. How far it skips is in the button's name and tooltip
 * ("Back 5 seconds"), not drawn inside the icon below the panel's type scale.
 */
const SkipGlyph = ({
  direction,
}: {
  readonly direction: "back" | "forward";
}) => {
  const Icon = direction === "back" ? RotateCcwIcon : RotateCwIcon;
  return <Icon aria-hidden="true" />;
};

/**
 * The bars, grouped into chapters. A chapter is as wide as its share of the
 * video, so a pointer maps to time through the chapter under it; the gap
 * between two chapters belongs to the nearer one.
 */
const Scrubber = ({
  chapters,
  currentMs,
  durationMs,
  onBarCount,
  onSeek,
  total,
  videoRef,
}: {
  readonly chapters: readonly RunVideoChapter[];
  readonly currentMs: number;
  readonly durationMs: number;
  readonly onBarCount: (count: number) => void;
  readonly onSeek: (ms: number) => void;
  readonly total: number;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(0);
  const draggingRef = useRef(false);
  const resumeRef = useRef(false);
  const [hover, setHover] = useState<{ ms: number; x: number } | undefined>();

  useEffect(() => {
    const track = trackRef.current;
    if (track === null) {
      return;
    }
    const measure = () => {
      const count = Math.floor(
        track.getBoundingClientRect().width / BAR_PITCH_PX
      );
      setBarCount(count);
      onBarCount(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [onBarCount]);

  const timeAt = (clientX: number): number => {
    const groups = [...(trackRef.current?.children ?? [])];
    for (const [index, chapter] of chapters.entries()) {
      const bounds = groups[index]?.getBoundingClientRect();
      const next = groups[index + 1]?.getBoundingClientRect().left;
      const boundary =
        bounds === undefined || next === undefined
          ? Number.POSITIVE_INFINITY
          : (bounds.right + next) / 2;
      if (bounds !== undefined && clientX < boundary) {
        const share =
          bounds.width === 0
            ? 0
            : Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
        return chapter.fromMs + share * (chapter.toMs - chapter.fromMs);
      }
    }
    return durationMs;
  };

  const point = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const ms = timeAt(event.clientX);
    const bounds = event.currentTarget.getBoundingClientRect();
    setHover({
      ms,
      x: Math.min(
        bounds.width - TIP_INSET_PX,
        Math.max(TIP_INSET_PX, event.clientX - bounds.left)
      ),
    });
    return ms;
  };

  const release = async () => {
    draggingRef.current = false;
    if (!resumeRef.current) {
      return;
    }
    resumeRef.current = false;
    try {
      await videoRef.current?.play();
    } catch {
      // Playback refused after the seek: stay paused where the drag ended.
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = new Map([
      ["ArrowDown", currentMs - scrubStepMs(durationMs)],
      ["ArrowLeft", currentMs - scrubStepMs(durationMs)],
      ["ArrowRight", currentMs + scrubStepMs(durationMs)],
      ["ArrowUp", currentMs + scrubStepMs(durationMs)],
      ["PageDown", currentMs - SKIP_MS],
      ["PageUp", currentMs + SKIP_MS],
      ["End", durationMs],
      ["Home", 0],
    ]).get(event.key);
    if (target !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      onSeek(target);
    }
  };

  const hovered =
    hover === undefined ? undefined : chapterAt(chapters, hover.ms);
  const current = chapterAt(chapters, currentMs);

  return (
    <div
      aria-label="Seek"
      aria-valuemax={ariaSeconds(durationMs)}
      aria-valuemin={0}
      aria-valuenow={ariaSeconds(currentMs)}
      aria-valuetext={`${clock(currentMs, durationMs)} of ${
        durationMs > 0 ? clock(durationMs, durationMs) : "unknown length"
      }${current === undefined ? "" : `, ${current.label}`}`}
      className={cn(
        "focus-visible:ring-offset-card relative flex h-[30px] cursor-pointer touch-none items-end rounded-sm focus-visible:ring-offset-4 pointer-coarse:h-11",
        FOCUS_RING
      )}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown PageUp PageDown Home End"
      onKeyDown={onKeyDown}
      onLostPointerCapture={release}
      title="Arrow keys step, Page Up and Page Down skip 5 seconds, Home and End jump to the ends"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        const video = videoRef.current;
        resumeRef.current = video !== null && !video.paused;
        video?.pause();
        draggingRef.current = true;
        onSeek(point(event));
      }}
      onPointerLeave={() => setHover(undefined)}
      onPointerMove={(event) => {
        const ms = point(event);
        if (draggingRef.current) {
          onSeek(ms);
        }
      }}
      role="slider"
      tabIndex={0}
    >
      <div
        className="flex size-full"
        ref={trackRef}
        style={{ gap: chapterGapPx(chapters.length, barCount) }}
      >
        {chapters.map((chapter) => (
          <div
            className="relative flex h-full min-w-0 items-end gap-0.5"
            key={chapter.fromMs}
            style={{ flexBasis: 0, flexGrow: chapter.toMs - chapter.fromMs }}
          >
            {chapter.bars.map((bar) => (
              <i
                className={cn(
                  "min-w-0 flex-1 rounded-[1.5px] transition-colors duration-100",
                  barTone(bar.atMs, currentMs, hover?.ms)
                )}
                key={bar.atMs}
                style={{ height: `${Math.round(bar.height * 100)}%` }}
              />
            ))}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-x-0 -bottom-1.5 h-0.5 rounded-full transition-colors",
                chapterLineTone(chapter === hovered, chapter === current)
              )}
            />
          </div>
        ))}
      </div>
      {hover === undefined || hovered === undefined ? null : (
        <span
          aria-hidden="true"
          className="bg-popover text-popover-foreground pointer-events-none absolute bottom-[calc(100%+10px)] max-w-64 -translate-x-1/2 truncate rounded-md border px-2 py-1 text-xs font-medium shadow-md"
          style={{ left: hover.x }}
        >
          <ChapterName chapter={hovered} total={total} />
          <span className="text-muted-foreground ml-1.5 font-mono font-normal tabular-nums">
            {clock(hover.ms, durationMs)}
          </span>
        </span>
      )}
    </div>
  );
};

/**
 * Where the video lives on this machine, copyable. The video is unredacted
 * local evidence, so the path is shown and copied, never uploaded
 * ([ADR 0010](../../../../../docs/adr/0010-run-video-is-unredacted.md)).
 */
const VideoPath = ({ path }: { readonly path: string }) => {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copy === "idle") {
      return;
    }
    const timer = setTimeout(() => setCopy("idle"), COPIED_FOR_MS);
    return () => clearTimeout(timer);
  }, [copy]);
  const label = {
    copied: "Copied",
    failed: "Couldn't copy",
    idle: "Copy path",
  }[copy];
  return (
    <div className="mt-2 flex items-center gap-2 border-t pt-2">
      <FileVideoIcon
        aria-hidden="true"
        className="text-muted-foreground size-3.5 shrink-0"
      />
      {/*
        One path: the folder gives way, the file name stays whole beside it.
      */}
      <span className="flex min-w-0 flex-1 font-mono text-xs" title={path}>
        <code className="text-muted-foreground min-w-0 truncate select-text">
          {tailOfPath(path).slice(0, -fileName(path).length)}
        </code>
        <code className="text-muted-foreground shrink-0 select-text">
          {fileName(path)}
        </code>
      </span>
      <Button
        aria-label="Copy video path"
        className={cn(
          copy === "copied" && "text-emerald-700 dark:text-emerald-400"
        )}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopy("copied");
          } catch {
            setCopy("failed");
          }
        }}
        size="xs"
        type="button"
        variant="ghost"
      >
        {copy === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        <span aria-live="polite">{label}</span>
      </Button>
    </div>
  );
};

/** The video element's state, and what the controls do to it. */
const usePlayback = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ambientRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  // Until the first play, the well says what the first frame is.
  const [started, setStarted] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  /** Tints the glass with the frame on screen, a few pixels wide. */
  const ambientBlend = useRef<AmbientBlend>(null);
  ambientBlend.current ??= makeAmbientBlend({
    draw: (alpha) => {
      const video = videoRef.current;
      const context = ambientRef.current?.getContext("2d");
      if (
        video === null ||
        context === null ||
        context === undefined ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      context.globalAlpha = alpha;
      context.drawImage(
        video,
        0,
        0,
        context.canvas.width,
        context.canvas.height
      );
      context.globalAlpha = 1;
    },
    playing: () =>
      videoRef.current !== null &&
      !videoRef.current.paused &&
      !videoRef.current.ended,
    reducedMotion: () =>
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ===
      true,
  });
  useEffect(() => () => ambientBlend.current?.stop(), []);

  const syncTime = () => {
    const video = videoRef.current;
    if (video !== null) {
      setCurrentMs(video.currentTime * 1000);
      ambientBlend.current?.frameChanged();
    }
  };

  const syncDuration = () => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (video.duration === Number.POSITIVE_INFINITY) {
      // A WebM written without a duration reports one only after a seek past
      // its end; `durationchange` then reports it and the seek is undone.
      video.currentTime = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (Number.isFinite(video.duration)) {
      setDurationMs(video.duration * 1000);
      if (video.currentTime > video.duration) {
        video.currentTime = 0;
      }
    }
  };

  const seek = (ms: number) => {
    const video = videoRef.current;
    if (video === null || durationMs <= 0) {
      return;
    }
    const clamped = Math.min(durationMs, Math.max(0, ms));
    // A seek shows a real frame, so the first-play cue has done its job.
    setStarted(true);
    video.currentTime = clamped / 1000;
    setCurrentMs(clamped);
  };

  const toggle = async () => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (!video.paused && !video.ended) {
      video.pause();
      return;
    }
    try {
      await video.play();
    } catch {
      // Playback refused, such as for an unreadable file: stay paused.
    }
  };

  const rate = PLAYBACK_RATES[rateIndex] ?? 1;
  const cycleRate = () => {
    const next = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(next);
    if (videoRef.current !== null) {
      videoRef.current.playbackRate = PLAYBACK_RATES[next] ?? 1;
    }
  };

  return {
    ambientRef,
    currentMs,
    cycleRate,
    durationMs,
    playing,
    rate,
    seek,
    started,
    toggle,
    videoEvents: {
      onDurationChange: syncDuration,
      onEnded: () => setPlaying(false),
      onLoadedData: () => ambientBlend.current?.frameChanged(true),
      onLoadedMetadata: syncDuration,
      onPause: () => setPlaying(false),
      onPlay: () => {
        setPlaying(true);
        setStarted(true);
        ambientBlend.current?.frameChanged();
      },
      onSeeked: syncTime,
      onTimeUpdate: syncTime,
    },
    videoRef,
  };
};

type Playback = ReturnType<typeof usePlayback>;

/** Whether `element` is the one shown fullscreen. */
const useFullscreen = (element: RefObject<HTMLElement | null>) => {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(
        (document.fullscreenElement ?? null) !== null &&
          document.fullscreenElement === element.current
      );
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [element]);
  const toggleFullscreen = async () => {
    try {
      // Absent, not null, where the Fullscreen API is missing.
      await ((document.fullscreenElement ?? null) === null
        ? element.current?.requestFullscreen()
        : document.exitFullscreen());
    } catch {
      // Fullscreen refused by the browser; the inline player stays.
    }
  };
  return { fullscreen, toggleFullscreen };
};

const PlayerControls = ({
  current,
  fullscreen,
  onToggleFullscreen,
  playback,
  total,
}: {
  readonly current: RunVideoChapter | undefined;
  readonly fullscreen: boolean;
  readonly onToggleFullscreen: () => Promise<void> | void;
  readonly playback: Playback;
  readonly total: number;
}) => (
  <>
    <div className="mt-3 flex items-center gap-1">
      <DockButton
        label="Back 5 seconds"
        onClick={() => playback.seek(playback.currentMs - SKIP_MS)}
      >
        <SkipGlyph direction="back" />
      </DockButton>
      <Button
        aria-label={playback.playing ? "Pause" : "Play"}
        className="mx-0.5"
        onClick={playback.toggle}
        size="icon-sm"
        title={playback.playing ? "Pause (Space)" : "Play (Space)"}
        type="button"
      >
        {playback.playing ? (
          <PauseIcon aria-hidden="true" className="fill-current" />
        ) : (
          <PlayIcon aria-hidden="true" className="fill-current" />
        )}
      </Button>
      <DockButton
        label="Forward 5 seconds"
        onClick={() => playback.seek(playback.currentMs + SKIP_MS)}
      >
        <SkipGlyph direction="forward" />
      </DockButton>
      <span className="text-muted-foreground ml-1.5 shrink-0 font-mono text-xs tabular-nums">
        {clock(playback.currentMs, playback.durationMs)}
        <span className="hidden @[20rem]:inline">
          {" / "}
          {/* Until the metadata arrives the length is unknown, not zero. */}
          {playback.durationMs > 0
            ? clock(playback.durationMs, playback.durationMs)
            : "—"}
        </span>
      </span>
      {current === undefined ? null : (
        <span
          className="ml-2 hidden min-w-0 truncate border-l pl-2.5 text-xs @[20rem]:block"
          // A truncated chapter reads in full on hover.
          title={current.label}
        >
          <ChapterName chapter={current} total={total} />
        </span>
      )}
      <span className="flex-1" />
      <Button
        aria-label={`Playback speed, ${playback.rate}×`}
        className="mr-0.5 tabular-nums"
        onClick={playback.cycleRate}
        size="xs"
        title="Playback speed"
        type="button"
        variant="outline"
      >
        {playback.rate}×
      </Button>
      <DockButton
        label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        onClick={onToggleFullscreen}
        title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
      >
        {fullscreen ? (
          <MinimizeIcon aria-hidden="true" className="size-4" />
        ) : (
          <MaximizeIcon aria-hidden="true" className="size-4" />
        )}
      </DockButton>
    </div>
    {current === undefined ? null : (
      <p className="mt-2 truncate text-xs @[20rem]:hidden">
        <ChapterName chapter={current} total={total} />
      </p>
    )}
  </>
);

/**
 * The player: the video on top and its controls below it, so no control
 * covers the recording. The scrubber has one chapter per action; its bars
 * rise through Action Windows and drop through fast-forwarded Idle Gaps.
 * Fullscreen keeps every control except the file path.
 */
const RunVideoPlayer = ({
  className,
  condensed,
  path,
  src,
  timeMap,
  timeline,
  videoClassName,
}: {
  readonly className: string | undefined;
  readonly condensed: boolean;
  readonly path: string | undefined;
  readonly src: string;
  readonly timeMap: RunVideoTimeMap | undefined;
  readonly timeline: readonly AgentTimelineEntry[];
  readonly videoClassName: string | undefined;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const playback = usePlayback();
  const { fullscreen, toggleFullscreen } = useFullscreen(rootRef);
  const [barCount, setBarCount] = useState(0);
  const chapters = runVideoChapters({
    barCount,
    condensed,
    durationMs: playback.durationMs,
    timeMap,
    timeline,
  });
  const total = Math.max(1, timeline.length);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    // A focused control keeps Space and the arrows for itself.
    const onControl =
      event.target instanceof HTMLElement &&
      event.target.closest("button,[role=slider]") !== null;
    if (event.key === "k" || (event.key === " " && !onControl)) {
      event.preventDefault();
      playback.toggle();
    } else if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !onControl
    ) {
      event.preventDefault();
      playback.seek(
        playback.currentMs +
          (event.key === "ArrowLeft" ? -1 : 1) *
            scrubStepMs(playback.durationMs)
      );
    } else if (event.key === "f") {
      event.preventDefault();
      toggleFullscreen();
    }
  };

  return (
    // Clicking the video focuses the player, so its shortcuts work at once.
    <div
      aria-label="Run video player"
      className={cn(
        "bg-card text-card-foreground relative isolate overflow-hidden outline-none select-none",
        // Inline, it is one card of the panel; fullscreen is a dark room
        // for watching, drawn with the same tokens in their dark values.
        fullscreen ? "dark flex h-full flex-col p-4" : "rounded-xl border",
        className
      )}
      onKeyDown={onKeyDown}
      ref={rootRef}
      role="group"
      tabIndex={-1}
    >
      {fullscreen ? (
        <canvas
          aria-hidden="true"
          className="reduce-transparency:hidden pointer-events-none absolute inset-0 -z-10 size-full opacity-55 blur-[48px] saturate-[1.6]"
          height={27}
          ref={playback.ambientRef}
          width={48}
        />
      ) : null}
      <div
        className={cn(
          // The well around a letterboxed picture is the panel's muted
          // surface, so the card's border frames it, not a black stage.
          "bg-muted relative overflow-hidden",
          fullscreen && "rounded-xl",
          fullscreen && "flex min-h-0 flex-1 items-center justify-center"
        )}
      >
        {/* Captions are not recorded; the track keeps the element valid. */}
        <video
          aria-description={
            playback.started ? undefined : "Play to watch the Run."
          }
          aria-label="Recorded Run video"
          className={cn(
            "block w-full cursor-pointer object-contain",
            fullscreen ? "h-full" : videoClassName
          )}
          onClick={playback.toggle}
          preload="metadata"
          ref={playback.videoRef}
          src={src}
          {...playback.videoEvents}
        >
          <track kind="captions" />
        </video>
        {/*
          A Run's recording starts before its first action, often on a blank
          page; a cue in the well says the player is ready, not empty. The
          video itself takes the click.
        */}
        {playback.started ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
          >
            <span className="bg-foreground text-background flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm ring-1 ring-white/40 dark:ring-black/40">
              <PlayIcon className="size-3.5 fill-current" />
              Play to watch the Run
            </span>
          </div>
        )}
      </div>
      <div
        className={cn(
          "@container px-3 py-2.5",
          fullscreen ? "mt-1.5 rounded-xl border" : "border-t"
        )}
      >
        <Scrubber
          chapters={chapters}
          currentMs={playback.currentMs}
          durationMs={playback.durationMs}
          onBarCount={setBarCount}
          onSeek={playback.seek}
          total={total}
          videoRef={playback.videoRef}
        />
        <PlayerControls
          current={chapterAt(chapters, playback.currentMs)}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          playback={playback}
          total={total}
        />
        {fullscreen || path === undefined ? null : <VideoPath path={path} />}
      </div>
    </div>
  );
};

/**
 * A finished Run's video. It is condensed after the Run ends — Idle Gaps
 * fast-forwarded, the agent's cursor drawn in — so until it is ready the
 * Workspace says so instead of offering a player with nothing to play
 * ([ADR 0046](../../../../../docs/adr/0046-run-video-condenses-idle-gaps-and-composites-the-agent-cursor.md)).
 * A video that could not be condensed plays in real time, with the reason.
 */
export const RunVideo = ({
  className,
  note,
  src,
  timeMap,
  timeline,
  videoClassName,
}: {
  readonly className?: string;
  /** Said under a video that exists, such as where it is kept. */
  readonly note?: React.ReactNode;
  readonly src: string;
  /** Places the Run's actions in the video; absent on older Summaries. */
  readonly timeMap: RunVideoTimeMap | undefined;
  readonly timeline: readonly AgentTimelineEntry[];
  readonly videoClassName?: string;
}) => {
  const { runVideoStatusAtom } = useRpcDependencies();
  const result = useAtomValue(runVideoStatusAtom(src));
  const status = result._tag === "Success" ? result.value : undefined;
  if (result._tag === "Initial" || status?.state === "preparing") {
    // One line until the player is ready, so a frame with nothing in it
    // never pushes the verdict and evidence down.
    return (
      <div
        aria-live="polite"
        className={cn(
          "text-muted-foreground flex w-full items-center justify-center gap-2 rounded-lg border py-3 text-xs",
          className
        )}
        role="status"
      >
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin"
        />
        Preparing video…
      </div>
    );
  }
  if (status?.state === "unavailable") {
    // Say why there is nothing to play, and where the Run's own files are,
    // so a missing video reads as a fact to act on rather than a dead end.
    return (
      <div className="space-y-1.5 text-xs" role="status">
        <p className="font-medium">This Run&apos;s video is not available.</p>
        <p className="text-muted-foreground text-pretty">{status.reason}</p>
        {status.directory === undefined ? null : (
          <EvidenceReference id={status.directory} kind="Run folder" />
        )}
      </div>
    );
  }
  // A status that could not be read leaves the player to try the file.
  return (
    <>
      <RunVideoPlayer
        className={className}
        condensed={status?.condensed ?? false}
        path={status?.path}
        src={src}
        timeMap={timeMap}
        timeline={timeline}
        videoClassName={videoClassName}
      />
      {status?.state === "ready" && !status.condensed ? (
        <p className="text-muted-foreground text-xs">
          Playing in real time. {status.reason}
        </p>
      ) : null}
      {note === undefined ? null : (
        <p className="text-muted-foreground text-xs">{note}</p>
      )}
    </>
  );
};
