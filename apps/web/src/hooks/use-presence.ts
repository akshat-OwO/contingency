import { useEffect, useRef, useState } from "react";

/**
 * How a transient surface arrives and leaves. It leaves by playing its
 * arrival backwards, so it exits along the path it entered on with the
 * easing mirrored, and a reversal mid-flight starts from where it is drawn.
 */
export interface PresenceMotion {
  /** The frame the surface enters from and leaves to. */
  readonly hidden: Keyframe;
  /** The frame it rests at; it must name the same properties as `hidden`. */
  readonly shown: Keyframe;
  readonly durationMs: number;
  readonly easing?: string;
}

/** Apple's sheet curve: a quick start that settles without overshoot. */
export const SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Under reduced motion a surface still cross-fades, because the change of
 * state aids comprehension, but nothing travels or scales.
 */
const keyframes = (motion: PresenceMotion): Keyframe[] =>
  prefersReducedMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [motion.hidden, motion.shown];

/** A transient surface's state while it enters, rests, and leaves. */
export interface Presence<A> {
  /** Animating out: the caller makes the surface inert while it goes. */
  readonly leaving: boolean;
  /** What to draw: the current value, or the last one while it leaves. */
  readonly rendered: A | undefined;
  /** Attaches to the element that moves. */
  readonly ref: (element: HTMLElement | null) => void;
}

/** The animation running on one element, so a new element starts afresh. */
interface Motion {
  readonly animation: Animation;
  readonly element: HTMLElement;
}

/**
 * Keeps a surface mounted while it animates out. `value` is what the surface
 * shows, or `undefined` once it should leave; `rendered` holds the last value
 * until the exit finishes, `leaving` marks that interval so the caller can
 * make the surface inert, and `ref` attaches to the element that moves.
 *
 * `value` must keep its identity across renders while it is unchanged: the
 * hook remembers each new value by setting state during render, so an object
 * built afresh on every render would never settle.
 *
 * The motion runs through the Web Animations API rather than CSS keyframes:
 * reversing a running animation turns it around from its current frame, so a
 * surface reopened while it is leaving never jumps. Where the API is missing,
 * the surface leaves at once.
 */
export const usePresence = <A>(
  value: A | undefined,
  motion: PresenceMotion
): Presence<A> => {
  const [retained, setRetained] = useState(value);
  if (value !== undefined && value !== retained) {
    setRetained(value);
  }
  const [element, setElement] = useState<HTMLElement | null>(null);
  const current = useRef<Motion | null>(null);
  const present = value !== undefined;

  useEffect(() => {
    if (element === null) {
      return;
    }
    const running =
      current.current?.element === element ? current.current.animation : null;
    if (present) {
      if (running === null) {
        current.current =
          "animate" in element
            ? {
                animation: element.animate(keyframes(motion), {
                  duration: motion.durationMs,
                  easing: motion.easing ?? SETTLE_EASING,
                  fill: "backwards",
                }),
                element,
              }
            : null;
      } else if (running.playbackRate < 0) {
        running.reverse();
      }
      return;
    }
    if (running === null) {
      setRetained(undefined);
      return;
    }
    // Hold the hidden frame once the reversal ends, so the surface does not
    // flash back to rest in the frame before it unmounts.
    running.effect?.updateTiming({ fill: "both" });
    if (running.playbackRate > 0) {
      running.reverse();
    }
    let interrupted = false;
    const leave = async () => {
      try {
        await running.finished;
      } catch {
        // A cancelled exit still leaves; nothing is left to draw.
      }
      if (!interrupted) {
        setRetained(undefined);
      }
    };
    void leave();
    return () => {
      interrupted = true;
    };
    // The motion is read when the surface arrives; a caller's new object for
    // the same motion must not restart it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [element, present]);

  return {
    leaving: !present && retained !== undefined,
    ref: setElement,
    rendered: value ?? retained,
  } satisfies Presence<A>;
};
