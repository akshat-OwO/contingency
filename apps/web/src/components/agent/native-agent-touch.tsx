import type {
  AgentSessionId,
  NativeAgentTouch as AgentTouch,
} from "@contingency/protocol";
import { cursorPointAt, planCursorPath } from "@contingency/protocol";
import { Effect, Fiber } from "effect";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useRpcDependencies } from "@/lib/rpc-dependencies";

/**
 * A touch older than this is history, not motion: a stage that joins or
 * reconnects hears the latest touch again, and replaying it would send the
 * dot travelling to an action already finished. As `AgentCursor`.
 */
const STALE_TOUCH_MS = 1500;

/**
 * How long the dot stays fully drawn after it lands before it dims, so it
 * marks where the agent is without covering the app between actions.
 */
const ACTIVE_MS = 700;

/** How long a swipe's finger takes to travel from its start to its end. */
const SWIPE_MS = 320;

/** How long the ring of a long press stays open. */
const PRESS_MS = 520;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Whether a frame and the screen a touch was measured on share a shape. */
const sameOrientation = (frame: Size, screen: Size) =>
  frame.width > 0 &&
  frame.height > 0 &&
  frame.width > frame.height === screen.width > screen.height;

/** Where a touch ends: a swipe's end, or the point it pressed. */
const restingPoint = (touch: AgentTouch): Point =>
  touch.action === "swipe" ? touch.end : { x: touch.x, y: touch.y };

/**
 * The finger lands: the dot dips and its ring opens. A long press holds the
 * ring open; a tap lets it go. Only the dot scales, never the positioned
 * element, so the dot cannot drift from its point.
 */
const pulse = (
  dot: HTMLElement,
  ring: HTMLElement,
  action: AgentTouch["action"]
) => {
  const held = action === "press" ? PRESS_MS : 0;
  dot.animate([{ scale: "1" }, { scale: "0.8" }, { scale: "1" }], {
    duration: 220 + held,
    easing: "ease-out",
  });
  ring.animate(
    [
      { opacity: 0.55, transform: "scale(0.5)" },
      { offset: held > 0 ? 0.7 : 0.1, opacity: 0.45, transform: "scale(1.3)" },
      { opacity: 0, transform: "scale(1.9)" },
    ],
    { duration: 420 + held, easing: "cubic-bezier(0.2, 0, 0, 1)" }
  );
};

/**
 * The agent's touch over a device's live frame: a dot labelled "Agent" that
 * travels to each point the agent taps, presses, or swipes from, and pulses
 * where it lands, as `AgentCursor` does on the Web stage (ADR 0046). The
 * user's own Forwarded Input is never drawn (ADR 0076).
 *
 * It fills its nearest positioned ancestor, which must be the device glass
 * the frame is drawn in, and places the touch by percentage of the frame, so
 * it needs nothing else from the layout. The motion runs on animation frames
 * against the dot's style rather than through React state, so a stroke never
 * re-renders the stage.
 */
export const NativeAgentTouch = ({
  frame,
  sessionId,
  visible,
}: {
  readonly sessionId: AgentSessionId;
  /** The decoded frame's size, in device pixels. */
  readonly frame: Size;
  /** Only while the agent holds the device; a person needs no ghost. */
  readonly visible: boolean;
}) => {
  const { runNativeAgentTouchStream } = useRpcDependencies();
  const [latest, setLatest] = useState<{
    readonly sessionId: AgentSessionId;
    readonly touch: AgentTouch;
  }>();
  const touch = latest?.sessionId === sessionId ? latest.touch : undefined;
  const touchRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);
  // Device pixels of the screen the last touch was measured on, so a resized
  // stage only rescales them.
  const positionRef = useRef<Point | null>(null);

  useEffect(() => {
    positionRef.current = null;
    const fiber = Effect.runFork(
      runNativeAgentTouchStream(sessionId, (next) =>
        Effect.sync(() => {
          setLatest({ sessionId, touch: next });
        })
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runNativeAgentTouchStream, sessionId]);

  const place = useEffectEvent((point: Point, screen: Size) => {
    positionRef.current = point;
    const element = touchRef.current;
    if (element === null) {
      return;
    }
    element.style.left = `${(point.x / screen.width) * 100}%`;
    element.style.top = `${(point.y / screen.height) * 100}%`;
  });

  useEffect(() => {
    if (touch === undefined) {
      return;
    }
    const { screen } = touch;
    const target = { x: touch.x, y: touch.y };
    const dot = dotRef.current;
    const ring = ringRef.current;
    const stale = Date.now() - touch.timestamp > STALE_TOUCH_MS;
    if (stale || prefersReducedMotion()) {
      place(restingPoint(touch), screen);
      if (dot !== null) {
        dot.dataset.resting = "";
      }
      return;
    }
    // A new touch starts from wherever the last one reached, including
    // partway through a stroke it interrupts; the first appears where it lands.
    const path = planCursorPath(
      positionRef.current ?? target,
      target,
      touch.durationMs
    );
    const swipe =
      touch.action === "swipe"
        ? planCursorPath(target, touch.end, SWIPE_MS, () => 0.5)
        : undefined;
    delete dot?.dataset.resting;
    let frameId = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    let startedAt: number | undefined;
    let landed = false;
    const step = (now: number) => {
      startedAt ??= now;
      const elapsed = now - startedAt;
      if (elapsed < path.durationMs) {
        place(cursorPointAt(path, elapsed), screen);
        frameId = requestAnimationFrame(step);
        return;
      }
      if (!landed) {
        landed = true;
        place(target, screen);
        if (dot !== null && ring !== null) {
          pulse(dot, ring, touch.action);
        }
      }
      if (swipe !== undefined && elapsed < path.durationMs + SWIPE_MS) {
        place(cursorPointAt(swipe, elapsed - path.durationMs), screen);
        frameId = requestAnimationFrame(step);
        return;
      }
      place(restingPoint(touch), screen);
      rest = setTimeout(() => {
        if (dot !== null) {
          dot.dataset.resting = "";
        }
      }, ACTIVE_MS);
    };
    frameId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(rest);
    };
  }, [touch]);

  // A frame turned against the screen the touch was measured on would put
  // the dot on the wrong control, so it is not drawn until they agree again.
  const shown =
    visible && touch !== undefined && sameOrientation(frame, touch.screen);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        className={`absolute top-0 left-0 transition-opacity duration-200 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        data-action={touch?.action}
        data-testid="agent-cursor"
        ref={touchRef}
      >
        <span
          className="absolute -top-[11px] -left-[11px] block size-[22px] rounded-full bg-blue-600/30 opacity-0 dark:bg-blue-400/30"
          ref={ringRef}
        />
        <span
          className="absolute -top-[11px] -left-[11px] block size-[22px] rounded-full border-2 border-white bg-blue-600/85 shadow-md transition-opacity duration-300 data-resting:opacity-50 dark:border-neutral-900 dark:bg-blue-400/85"
          ref={dotRef}
        />
        <span className="absolute top-3.5 left-3.5 rounded-full bg-blue-600 px-1.5 py-px text-[11px] leading-4 font-medium text-white shadow-sm dark:bg-blue-400 dark:text-neutral-950">
          Agent
        </span>
      </div>
    </div>
  );
};
