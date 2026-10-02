import {
  AGENT_POINTER_ENTRY_OFFSET,
  cursorPointAt,
  planCursorPath,
} from "@contingency/protocol";
import type { CursorPath, CursorPoint } from "@contingency/protocol";

import type { RunSpan } from "./run-video-plan.ts";

// The Workspace's agent cursor, replayed against the Run's clock rather than
// animation frames. The timings mirror `agent-cursor.tsx`, so the cursor in a
// Run's video moves, presses, and dims as the live one did.

/** How long the cursor stays fully drawn after it lands before it dims. */
const ACTIVE_MS = 700;
/** The dimming and brightening transition, and the level it dims to. */
const REST_TRANSITION_MS = 300;
const RESTING_OPACITY = 0.4;
/** The press: the arrow dips while a ring opens. */
const PRESS_MS = 220;
const RING_MS = 420;
/** The cursor fades when a person takes the browser, and back on return. */
const VISIBILITY_MS = 200;

/** Where the agent pointed, in the video's pixels and the Run's clock. */
export interface FootagePointer {
  readonly action: "click" | "move";
  readonly atMs: number;
  readonly durationMs: number;
  readonly x: number;
  readonly y: number;
}

export interface CursorStroke {
  readonly action: FootagePointer["action"];
  readonly atMs: number;
  readonly path: CursorPath;
  /** The arrow's opacity as the stroke began, mid-dim or rested. */
  readonly startOpacity: number;
}

/** What to draw for the cursor in one frame, or nothing. */
export interface CursorFrame {
  readonly glyphScale: number;
  readonly opacity: number;
  readonly ringOpacity: number;
  readonly ringScale: number;
  readonly x: number;
  readonly y: number;
}

const RANDOM_MODULUS = 4_294_967_296;

/** A repeatable stand-in for `Math.random`, so a re-render draws the same arc. */
const seeded = (seed: number) => {
  let state = Math.abs(Math.trunc(seed)) % RANDOM_MODULUS;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % RANDOM_MODULUS;
    return state / RANDOM_MODULUS;
  };
};

const easeOut = (time: number): number => 1 - (1 - time) ** 2;
/** Close to the ring's `cubic-bezier(0.2, 0, 0, 1)`: fast out, long settle. */
const easeOutQuart = (time: number): number => 1 - (1 - time) ** 4;
const lerp = (from: number, to: number, share: number): number =>
  from + (to - from) * Math.min(1, Math.max(0, share));

/** The arrow's opacity `atMs` into the Run, given the stroke then playing. */
const strokeOpacity = (stroke: CursorStroke, atMs: number): number => {
  const restsAt = stroke.atMs + stroke.path.durationMs + ACTIVE_MS;
  if (atMs >= restsAt) {
    return lerp(1, RESTING_OPACITY, (atMs - restsAt) / REST_TRANSITION_MS);
  }
  return lerp(
    stroke.startOpacity,
    1,
    (atMs - stroke.atMs) / REST_TRANSITION_MS
  );
};

/**
 * Draw every stroke once. A stroke starts wherever the previous one had
 * reached, even partway, exactly as a new pointer interrupts the live cursor.
 */
export const planCursorStrokes = (
  pointers: readonly FootagePointer[]
): readonly CursorStroke[] => {
  const strokes: CursorStroke[] = [];
  for (const pointer of pointers.toSorted(
    (left, right) => left.atMs - right.atMs
  )) {
    const previous = strokes.at(-1);
    const target = { x: pointer.x, y: pointer.y };
    const from: CursorPoint =
      previous === undefined
        ? {
            x: target.x + AGENT_POINTER_ENTRY_OFFSET.x,
            y: target.y + AGENT_POINTER_ENTRY_OFFSET.y,
          }
        : cursorPointAt(previous.path, pointer.atMs - previous.atMs);
    strokes.push({
      action: pointer.action,
      atMs: pointer.atMs,
      path: planCursorPath(
        from,
        target,
        pointer.durationMs,
        seeded(pointer.atMs)
      ),
      startOpacity:
        previous === undefined ? 1 : strokeOpacity(previous, pointer.atMs),
    });
  }
  return strokes;
};

/** The arrow's dip on a press: down to 82% and back, over the press. */
const pressScale = (press: number): number =>
  press < 0.5 ? lerp(1, 0.82, press * 2) : lerp(0.82, 1, (press - 0.5) * 2);

/** How visible the cursor is around Takeover, which hides it. */
const visibility = (takeovers: readonly RunSpan[], atMs: number): number => {
  let level = 1;
  for (const takeover of takeovers) {
    if (atMs < takeover.fromMs) {
      break;
    }
    level =
      atMs <= takeover.toMs
        ? lerp(1, 0, (atMs - takeover.fromMs) / VISIBILITY_MS)
        : lerp(0, 1, (atMs - takeover.toMs) / VISIBILITY_MS);
  }
  return level;
};

const strokeAt = (
  strokes: readonly CursorStroke[],
  atMs: number
): CursorStroke | undefined => {
  let low = 0;
  let high = strokes.length - 1;
  let found: CursorStroke | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const stroke = strokes[middle];
    if (stroke !== undefined && stroke.atMs <= atMs) {
      found = stroke;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

/**
 * The cursor `atMs` into the Run. Before the agent first points there is no
 * cursor, as there is none in the Workspace.
 */
export const cursorAt = (
  strokes: readonly CursorStroke[],
  takeovers: readonly RunSpan[],
  atMs: number
): CursorFrame | undefined => {
  const stroke = strokeAt(strokes, atMs);
  if (stroke === undefined) {
    return;
  }
  const visible = visibility(takeovers, atMs);
  if (visible <= 0) {
    return;
  }
  const elapsed = atMs - stroke.atMs;
  const point = cursorPointAt(stroke.path, elapsed);
  const sinceLanding = elapsed - stroke.path.durationMs;
  const pressing = stroke.action === "click" && sinceLanding >= 0;
  const press = pressing ? easeOut(sinceLanding / PRESS_MS) : 1;
  const ring = pressing ? easeOutQuart(sinceLanding / RING_MS) : 1;
  return {
    glyphScale: pressing && sinceLanding < PRESS_MS ? pressScale(press) : 1,
    opacity: strokeOpacity(stroke, atMs) * visible,
    ringOpacity:
      pressing && sinceLanding < RING_MS ? lerp(0.55, 0, ring) * visible : 0,
    ringScale: lerp(0.4, 1.6, ring),
    x: point.x,
    y: point.y,
  };
};
