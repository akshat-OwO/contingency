import type { BrowserAgentPointer } from "@contingency/protocol";
import { AGENT_POINTER_ENTRY_OFFSET } from "@contingency/protocol";
import { MousePointer2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  cursorPointAt,
  planCursorPath,
} from "@/components/agent/agent-cursor-path";
import type {
  CanvasBox,
  Point,
} from "@/components/agent/teaching-inspect-geometry";
import { projectPageRectangle } from "@/components/agent/teaching-inspect-geometry";
import type { FrameProjection } from "@/components/agent/teaching-inspect-state";
import { useCanvasBox } from "@/components/agent/use-canvas-box";

/**
 * A pointer older than this is history, not motion: a Workspace that joins or
 * reconnects replays the stream's recent events, and replaying old strokes
 * would send the cursor wandering through actions already finished.
 */
const STALE_POINTER_MS = 1500;

/**
 * How long the cursor stays fully drawn after it lands before it dims, so it
 * marks where the agent is without covering the Page between actions.
 */
const ACTIVE_MS = 700;

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const overlayPoint = (
  point: Point,
  projection: FrameProjection,
  box: CanvasBox
): Point => {
  const { left, top } = projectPageRectangle(
    { height: 0, width: 0, ...point },
    projection,
    box
  );
  return { x: left, y: top };
};

/**
 * The press the agent made when it arrived: the arrow dips and a ring opens.
 * Only the glyph scales. Scaling the positioned element would scale its
 * translation too, which flung the cursor towards the frame's corner and back
 * on every click.
 */
const pulse = (glyph: HTMLElement, ring: HTMLElement) => {
  glyph.animate([{ scale: "1" }, { scale: "0.82" }, { scale: "1" }], {
    duration: 220,
    easing: "ease-out",
  });
  ring.animate(
    [
      { opacity: 0.55, transform: "scale(0.4)" },
      { opacity: 0, transform: "scale(1.6)" },
    ],
    { duration: 420, easing: "cubic-bezier(0.2, 0, 0, 1)" }
  );
};

/**
 * The agent's cursor over the live frame. It travels to each point the agent
 * acts on along a freshly drawn, slightly bowed stroke, and pulses where the
 * agent clicks, so a watcher can follow which control the agent reached for.
 * The motion runs on animation frames against the element's style rather
 * than through React state, so a stroke never re-renders the Workspace.
 */
export const AgentCursor = ({
  canvas,
  pointer,
  projection,
  visible,
}: {
  readonly canvas: HTMLCanvasElement | null;
  readonly pointer: BrowserAgentPointer | undefined;
  readonly projection: FrameProjection;
  /** Only while the agent holds the browser; a person needs no ghost. */
  readonly visible: boolean;
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const box = useCanvasBox(canvas, container);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const glyphRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);
  // Page viewport coordinates, so a resized column only rescales them.
  const positionRef = useRef<Point | null>(null);

  const place = useEffectEvent((point: Point) => {
    positionRef.current = point;
    const cursor = cursorRef.current;
    if (cursor === null) {
      return;
    }
    const at = overlayPoint(point, projection, box);
    cursor.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
  });

  useEffect(() => {
    const position = positionRef.current;
    if (position !== null) {
      place(position);
    }
  }, [box, projection]);

  useEffect(() => {
    if (pointer === undefined) {
      return;
    }
    const target = { x: pointer.x, y: pointer.y };
    const stale = Date.now() - pointer.timestamp > STALE_POINTER_MS;
    if (stale || prefersReducedMotion()) {
      place(target);
      return;
    }
    // A new pointer starts its stroke from wherever the last one reached,
    // including partway through a stroke it interrupts.
    const path = planCursorPath(
      positionRef.current ?? {
        x: target.x + AGENT_POINTER_ENTRY_OFFSET.x,
        y: target.y + AGENT_POINTER_ENTRY_OFFSET.y,
      },
      target,
      pointer.durationMs
    );
    const glyph = glyphRef.current;
    delete glyph?.dataset.resting;
    let frame = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    let startedAt: number | undefined;
    const step = (now: number) => {
      startedAt ??= now;
      const elapsed = now - startedAt;
      place(cursorPointAt(path, elapsed));
      if (elapsed < path.durationMs) {
        frame = requestAnimationFrame(step);
        return;
      }
      const ring = ringRef.current;
      if (pointer.action === "click" && glyph !== null && ring !== null) {
        pulse(glyph, ring);
      }
      rest = setTimeout(() => {
        if (glyph !== null) {
          glyph.dataset.resting = "";
        }
      }, ACTIVE_MS);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(rest);
    };
  }, [pointer]);

  const shown = visible && pointer !== undefined;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      ref={setContainer}
    >
      <div
        className={`absolute top-0 left-0 transition-opacity duration-200 will-change-transform ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        data-testid="agent-cursor"
        ref={cursorRef}
      >
        <span
          className="absolute -top-3 -left-3 block size-6 rounded-full bg-blue-600/25 opacity-0 dark:bg-blue-400/25"
          ref={ringRef}
        />
        <div
          className="transition-opacity duration-300 data-resting:opacity-40"
          ref={glyphRef}
        >
          {/* The pointer's tip sits at (3.4, 3.9) in its box, on the point. */}
          <MousePointer2Icon className="fill-background absolute -top-[3.9px] -left-[3.4px] size-5 text-blue-600 drop-shadow-sm dark:text-blue-400" />
        </div>
      </div>
    </div>
  );
};
