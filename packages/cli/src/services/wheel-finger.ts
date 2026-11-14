import type { NativeInput } from "@contingency/protocol";

type Touch = Extract<NativeInput, { readonly _tag: "touch" }>;
type Key = Extract<NativeInput, { readonly _tag: "key" }>;
/** What a device without a wheel receives: one finger and the keyboard. */
export type FingerInput = Touch | Key;

/** How long the wheel stays quiet before the finger lifts. */
export const WHEEL_RELEASE_MILLIS = 250;
/** How far one browser wheel notch drags, as a fraction of the display. */
const NOTCH_FRACTION = 0.1;
const WHEEL_NOTCH = 100;
/**
 * The shortest first drag, as a fraction of the display. A finger that moves
 * less than the platform's touch slop lifts as a tap, so smaller wheel deltas
 * wait until they add up.
 */
export const MIN_DRAG_FRACTION = 0.03;
/** How far each resting move before a lift goes: about a point. */
const REST_NUDGE = 0.0025;
/** Resting moves before a lift, enough to fill a velocity estimate. */
export const REST_MOVES = 4;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);
/** A start near `at` from which a drag of `travel` stays on the display. */
const dragStart = (at: number, travel: number) =>
  clamp(at, Math.max(0, -travel), Math.min(1, 1 - travel));
const inside = (value: number) => value >= 0 && value <= 1;
/** Positions to a ten-thousandth, far below a pixel, so sums stay exact. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * Turns wheel input into one held finger, for devices that have no wheel. The
 * finger goes down when the wheel first turns far enough to scroll, follows
 * the wheel's travel as it turns, and lifts once the wheel is quiet, so the
 * content tracks the wheel the way a browser page does, with no fixed-length
 * swipe queued behind each notch. Turned down, the content moves up.
 *
 * The finger lifts after holding still, so the release does not fling. One
 * that would leave the display lifts and goes down again further in; the next
 * down stops any fling straight away. A touch lifts it first, and keys pass
 * through.
 */
export const makeWheelFinger = () => {
  let pendingX = 0;
  let pendingY = 0;
  let finger: { x: number; y: number } | undefined;
  const lift = (at: number): Touch[] => {
    if (finger === undefined) {
      return [];
    }
    const { x, y } = finger;
    finger = undefined;
    return [{ _tag: "touch", action: "up", at, x, y }];
  };
  const put = (at: number, x: number, y: number): Touch[] => {
    const travelX = pendingX;
    const travelY = pendingY;
    if (Math.max(Math.abs(travelX), Math.abs(travelY)) < MIN_DRAG_FRACTION) {
      return [];
    }
    pendingX = 0;
    pendingY = 0;
    const startX = round(dragStart(x, clamp(travelX, -1, 1)));
    const startY = round(dragStart(y, clamp(travelY, -1, 1)));
    finger = {
      x: round(clamp(startX + travelX, 0, 1)),
      y: round(clamp(startY + travelY, 0, 1)),
    };
    return [
      { _tag: "touch", action: "down", at, x: startX, y: startY },
      { _tag: "touch", action: "move", at, ...finger },
    ];
  };
  return {
    /** The inputs a device receives for one Forwarded Input, in order. */
    feed: (input: NativeInput): FingerInput[] => {
      if (input._tag === "key") {
        return [input];
      }
      if (input._tag === "touch") {
        pendingX = 0;
        pendingY = 0;
        return [...lift(input.at), input];
      }
      const travelX = (-input.deltaX / WHEEL_NOTCH) * NOTCH_FRACTION;
      const travelY = (-input.deltaY / WHEEL_NOTCH) * NOTCH_FRACTION;
      if (travelX === 0 && travelY === 0) {
        return [];
      }
      if (finger === undefined) {
        pendingX += travelX;
        pendingY += travelY;
        return put(input.at, input.x, input.y);
      }
      const x = round(finger.x + travelX);
      const y = round(finger.y + travelY);
      if (inside(x) && inside(y)) {
        finger = { x, y };
        return [{ _tag: "touch", action: "move", at: input.at, x, y }];
      }
      // Out of room: lift and start again under the pointer, which is over
      // the content being scrolled, so a long scroll keeps going stroke after
      // stroke as a finger's would.
      pendingX += travelX;
      pendingY += travelY;
      return [...lift(input.at), ...put(input.at, input.x, input.y)];
    },
    /** Whether a finger is down and waiting for the wheel to go quiet. */
    holding: () => finger !== undefined,
    /**
     * Lifts the finger once the wheel is quiet. A simulator hears a finger
     * only when it moves, so a still finger lifts with the speed of its last
     * moves and flings the content. Resting moves of about a point, sent at
     * the drag spacing before the lift, show the platform a finger at rest,
     * as a real touchscreen reports one.
     */
    release: (at: number): FingerInput[] => {
      if (finger === undefined) {
        return [];
      }
      const { x, y } = finger;
      const nudge = x > 0.5 ? -REST_NUDGE : REST_NUDGE;
      const rests = Array.from({ length: REST_MOVES }, (_, index): Touch => ({
        _tag: "touch",
        action: "move",
        at,
        x: round(x + (index % 2 === 0 ? nudge : 0)),
        y,
      }));
      return [...rests, ...lift(at)];
    },
  };
};
export type WheelFinger = ReturnType<typeof makeWheelFinger>;
