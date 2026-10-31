/**
 * The blurred backdrop behind the Run video. It eases toward the frame on
 * screen instead of jumping to it, so a scene cut or a seek glows across
 * rather than flashing (#595).
 */

/** How long a backdrop takes to show 95% of a new frame. */
export const AMBIENT_SETTLE_MS = 400;

/** One display frame, for the first draw of a blend. */
const FRAME_MS = 1000 / 60;

/** What remains of the old backdrop once a blend has settled. */
const SETTLED_REMAINDER = 0.05;

/**
 * How much of the current frame to draw over the backdrop after
 * `elapsedMs`. Drawing with this opacity every animation frame reaches 95% of
 * a new scene in `AMBIENT_SETTLE_MS` at any refresh rate. Reduced motion
 * replaces the backdrop outright.
 */
export const ambientFrameAlpha = (
  elapsedMs: number,
  reducedMotion: boolean
): number =>
  reducedMotion
    ? 1
    : 1 - SETTLED_REMAINDER ** (Math.max(0, elapsedMs) / AMBIENT_SETTLE_MS);

export interface AmbientBlend {
  /**
   * The video frame changed. `instant` paints it outright, for the first
   * frame of a video.
   */
  readonly frameChanged: (instant?: boolean) => void;
  readonly stop: () => void;
}

/** The display's frame clock; tests pass their own. */
export interface FrameScheduler {
  readonly cancel: (handle: number) => void;
  readonly request: (onFrame: (now: number) => void) => number;
}

const animationFrames: FrameScheduler = {
  cancel: (handle) => cancelAnimationFrame(handle),
  request: (onFrame) => requestAnimationFrame(onFrame),
};

export interface AmbientBlendTarget {
  /** Paints the frame on screen over the backdrop at `alpha` opacity. */
  readonly draw: (alpha: number) => void;
  /** Whether the video is advancing on its own. */
  readonly playing: () => boolean;
  readonly reducedMotion: () => boolean;
}

/**
 * Blends the video into its backdrop. The loop runs only while the video
 * plays or a blend is still settling, so a paused player costs nothing.
 */
export const makeAmbientBlend = (
  { draw, playing, reducedMotion }: AmbientBlendTarget,
  frames: FrameScheduler = animationFrames
): AmbientBlend => {
  let frame: number | undefined;
  let previous: number | undefined;
  let changed = false;
  let settleUntil = 0;

  // Every time comes from the animation frame's own clock.
  const tick = (now: number) => {
    frame = undefined;
    if (changed) {
      changed = false;
      // Tail past the 95% point so the last few percent land too.
      settleUntil = now + AMBIENT_SETTLE_MS * 2;
    }
    const reduced = reducedMotion();
    draw(ambientFrameAlpha(now - (previous ?? now - FRAME_MS), reduced));
    previous = now;
    if ((playing() && !reduced) || now < settleUntil) {
      frame = frames.request(tick);
    }
  };

  return {
    frameChanged: (instant = false) => {
      if (instant || reducedMotion()) {
        draw(1);
        return;
      }
      changed = true;
      if (frame === undefined) {
        previous = undefined;
        frame = frames.request(tick);
      }
    },
    stop: () => {
      if (frame !== undefined) {
        frames.cancel(frame);
        frame = undefined;
      }
    },
  };
};
