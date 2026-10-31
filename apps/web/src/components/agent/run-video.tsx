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

import { makeAmbientBlend } from "@/components/agent/run-video-ambient";
import type { AmbientBlend } from "@/components/agent/run-video-ambient";
import { runVideoChapters } from "@/components/agent/run-video-timeline";
import type { RunVideoChapter } from "@/components/agent/run-video-timeline";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

const SKIP_MS = 5000;
const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;
/** One bar per this many pixels of scrubber. */
const BAR_PITCH_PX = 5;
const COPIED_FOR_MS = 1500;
/** How far the hover tip stays from either end of the scrubber. */
const TIP_INSET_PX = 64;

const FOCUS_RING =
  "focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none";

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
    return "bg-white";
  }
  if (hoverMs !== undefined && atMs < hoverMs) {
    return "bg-white/40";
  }
  return "bg-white/20";
};

const chapterLineTone = (hovered: boolean, current: boolean): string => {
  if (hovered) {
    return "bg-white/80";
  }
  return current ? "bg-white/55" : "bg-white/12";
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
      <span className="mr-1 text-white/55 tabular-nums">
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
  <button
    aria-label={label}
    className={cn(
      "grid size-[30px] shrink-0 place-items-center rounded-full text-white/75 transition-colors hover:bg-white/12 hover:text-white active:scale-[0.94]",
      FOCUS_RING
    )}
    onClick={onClick}
    title={title}
    type="button"
  >
    {children}
  </button>
);

/** A circular arrow around the number of seconds it skips. */
const SkipGlyph = ({
  direction,
}: {
  readonly direction: "back" | "forward";
}) => {
  const Icon = direction === "back" ? RotateCcwIcon : RotateCwIcon;
  return (
    <span aria-hidden="true" className="relative grid place-items-center">
      <Icon className="size-[18px]" strokeWidth={1.75} />
      <span className="absolute pt-px text-[7px] font-bold">
        {SKIP_MS / 1000}
      </span>
    </span>
  );
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
      ["ArrowDown", currentMs - SKIP_MS],
      ["ArrowLeft", currentMs - SKIP_MS],
      ["ArrowRight", currentMs + SKIP_MS],
      ["ArrowUp", currentMs + SKIP_MS],
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
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuemin={0}
      aria-valuenow={Math.round(currentMs / 1000)}
      aria-valuetext={`${clock(currentMs)} of ${clock(durationMs)}${
        current === undefined ? "" : `, ${current.label}`
      }`}
      className={cn(
        "relative flex h-[30px] cursor-pointer touch-none items-end rounded-sm focus-visible:ring-offset-4 focus-visible:ring-offset-zinc-900",
        FOCUS_RING
      )}
      onKeyDown={onKeyDown}
      onLostPointerCapture={release}
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
          className="pointer-events-none absolute bottom-[calc(100%+10px)] max-w-64 -translate-x-1/2 truncate rounded-lg border border-white/10 bg-zinc-950/90 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-md"
          style={{ left: hover.x }}
        >
          <ChapterName chapter={hovered} total={total} />
          <span className="ml-1.5 font-mono font-normal text-white/60 tabular-nums">
            {clock(hover.ms)}
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
    <div className="mt-2.5 flex items-center gap-2 rounded-full border border-white/8 bg-white/5 py-[5px] pr-[5px] pl-3">
      <FileVideoIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 opacity-50"
      />
      <code
        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-white/60 select-text"
        title={path}
      >
        {path}
      </code>
      <button
        aria-label="Copy video path"
        className={cn(
          "flex h-[26px] shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[11.5px] transition-colors hover:bg-white/18",
          FOCUS_RING,
          copy === "copied" && "text-emerald-300"
        )}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopy("copied");
          } catch {
            setCopy("failed");
          }
        }}
        type="button"
      >
        {copy === "copied" ? (
          <CheckIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-3.5" />
        )}
        <span aria-live="polite">{label}</span>
      </button>
    </div>
  );
};

/** The video element's state, and what the controls do to it. */
const usePlayback = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ambientRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
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
    toggle,
    videoEvents: {
      onDurationChange: syncDuration,
      onEnded: () => setPlaying(false),
      onLoadedData: () => ambientBlend.current?.frameChanged(true),
      onLoadedMetadata: syncDuration,
      onPause: () => setPlaying(false),
      onPlay: () => {
        setPlaying(true);
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
    <div className="mt-3.5 flex items-center gap-1">
      <DockButton
        label="Back 5 seconds"
        onClick={() => playback.seek(playback.currentMs - SKIP_MS)}
      >
        <SkipGlyph direction="back" />
      </DockButton>
      <button
        aria-label={playback.playing ? "Pause" : "Play"}
        className={cn(
          "mx-0.5 grid size-[34px] shrink-0 place-items-center rounded-full bg-white text-zinc-950 transition-transform active:scale-[0.92]",
          FOCUS_RING
        )}
        onClick={playback.toggle}
        title={playback.playing ? "Pause (Space)" : "Play (Space)"}
        type="button"
      >
        {playback.playing ? (
          <PauseIcon aria-hidden="true" className="size-4 fill-current" />
        ) : (
          <PlayIcon aria-hidden="true" className="ml-0.5 size-4 fill-current" />
        )}
      </button>
      <DockButton
        label="Forward 5 seconds"
        onClick={() => playback.seek(playback.currentMs + SKIP_MS)}
      >
        <SkipGlyph direction="forward" />
      </DockButton>
      <span className="ml-1.5 shrink-0 font-mono text-xs text-white/70 tabular-nums">
        {clock(playback.currentMs)}
        <span className="hidden @[20rem]:inline">
          {" / "}
          {clock(playback.durationMs)}
        </span>
      </span>
      {current === undefined ? null : (
        <span className="ml-2 hidden min-w-0 truncate border-l border-white/15 pl-2.5 text-xs @[20rem]:block">
          <ChapterName chapter={current} total={total} />
        </span>
      )}
      <span className="flex-1" />
      <button
        aria-label={`Playback speed, ${playback.rate}×`}
        className={cn(
          "mr-0.5 h-6 shrink-0 rounded-full border border-white/15 px-2 text-[11px] font-semibold text-white/75 transition-colors hover:bg-white/10 hover:text-white",
          FOCUS_RING
        )}
        onClick={playback.cycleRate}
        title="Playback speed"
        type="button"
      >
        {playback.rate}×
      </button>
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
 * The player: the video on top and a glass dock below it, so no control
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
        playback.currentMs + (event.key === "ArrowLeft" ? -SKIP_MS : SKIP_MS)
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
        "relative isolate overflow-hidden bg-[#0c0c0f] text-white outline-none select-none",
        fullscreen ? "flex h-full flex-col p-4" : "rounded-[18px] p-1.5",
        className
      )}
      onKeyDown={onKeyDown}
      ref={rootRef}
      role="group"
      tabIndex={-1}
    >
      <canvas
        aria-hidden="true"
        className="reduce-transparency:hidden pointer-events-none absolute inset-0 -z-10 size-full opacity-55 blur-[48px] saturate-[1.6]"
        height={27}
        ref={playback.ambientRef}
        width={48}
      />
      <div
        className={cn(
          "relative overflow-hidden rounded-xl bg-black",
          fullscreen && "flex min-h-0 flex-1 items-center justify-center"
        )}
      >
        {/* Captions are not recorded; the track keeps the element valid. */}
        <video
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
      </div>
      <div className="reduce-transparency:bg-zinc-900 reduce-transparency:backdrop-blur-none @container mt-1.5 rounded-xl border border-white/10 bg-zinc-900/55 px-3 py-2.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-xl backdrop-saturate-[1.8]">
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
  src,
  timeMap,
  timeline,
  videoClassName,
}: {
  readonly className?: string;
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
    return (
      <div
        aria-live="polite"
        className={cn(
          "text-muted-foreground flex aspect-video w-full items-center justify-center gap-2 rounded-lg border text-xs",
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
    return (
      <p className="text-muted-foreground text-xs">
        This Run&apos;s video is no longer available.
      </p>
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
    </>
  );
};
