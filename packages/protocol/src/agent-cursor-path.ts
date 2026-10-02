/** A point in Page viewport pixels. */
export interface CursorPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One stroke of the agent's cursor between two Page viewport points: a single
 * shallow arc bowed to a random side by a random amount, so two moves between
 * the same points rarely trace the same line. It follows agent-browser's
 * human input mode — eased progress along the line, with the bow applied on
 * raw time so the arc peaks mid-stroke — rather than a wandering path, which
 * reads as jitter at the speed a stroke runs. The Workspace draws it live and
 * the Run's video draws it again, so both share this one definition.
 */
export interface CursorPath {
  /** Signed sideways offset at the middle of the stroke, in Page pixels. */
  readonly bend: number;
  readonly durationMs: number;
  readonly from: CursorPoint;
  readonly to: CursorPoint;
}

/** A source of uniform numbers in [0, 1), injected so tests are repeatable. */
export type RandomSource = () => number;

/** The widest bow, as a share of the stroke and in Page pixels. */
const BEND_SHARE = 0.1;
const BEND_LIMIT = 40;

/**
 * Draw one stroke. Its duration comes from the server, which waits that long
 * before acting, so only the stroke's shape is random.
 */
export const planCursorPath = (
  from: CursorPoint,
  to: CursorPoint,
  durationMs: number,
  random: RandomSource = Math.random
): CursorPath => {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const reach = Math.min(BEND_LIMIT, distance * BEND_SHARE);
  // Uniform in [-reach, reach], so some strokes run almost straight.
  return { bend: (random() * 2 - 1) * reach, durationMs, from, to };
};

/**
 * Minimum-jerk progress: a reaching hand accelerates smoothly and settles
 * without a jolt.
 */
const ease = (time: number): number =>
  time * time * time * (10 - 15 * time + 6 * time * time);

/** Where the cursor is `elapsedMs` into the stroke. */
export const cursorPointAt = (
  path: CursorPath,
  elapsedMs: number
): CursorPoint => {
  if (path.durationMs <= 0 || elapsedMs >= path.durationMs) {
    return path.to;
  }
  const time = Math.max(0, elapsedMs / path.durationMs);
  const dx = path.to.x - path.from.x;
  const dy = path.to.y - path.from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return path.to;
  }
  const share = ease(time);
  const arc = 4 * time * (1 - time) * path.bend;
  return {
    x: path.from.x + dx * share + (-dy / distance) * arc,
    y: path.from.y + dy * share + (dx / distance) * arc,
  };
};
