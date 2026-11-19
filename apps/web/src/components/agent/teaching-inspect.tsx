import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { InspectHint } from "@/components/agent/comment-card";
import type { OverlayRectangle } from "@/components/agent/teaching-inspect-geometry";
import {
  pagePointOf,
  projectDocumentRectangle,
  projectPageRectangle,
} from "@/components/agent/teaching-inspect-geometry";
import type {
  FrameProjection,
  InspectState,
} from "@/components/agent/teaching-inspect-state";
import { useCanvasBox } from "@/components/agent/use-canvas-box";

const Pin = ({
  at,
  index,
}: {
  readonly at: OverlayRectangle;
  readonly index: number;
}) => (
  <span
    className="bg-status-running border-background absolute grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 font-mono text-xs font-semibold text-white shadow-[0_2px_6px_oklch(0_0_0/0.25)]"
    style={{ left: at.left + at.width / 2, top: at.top }}
  >
    {index}
  </span>
);

/**
 * The box around an element. Moving the pointer to another element glides the
 * box there rather than redrawing it, so the eye follows which element the
 * pick moved to; a new hover retargets from wherever the box is drawn.
 */
const Outline = ({
  at,
  label,
}: {
  readonly at: OverlayRectangle;
  readonly label?: string | undefined;
}) => (
  <span
    className="border-status-running bg-status-running/15 pointer-events-none absolute top-0 left-0 block rounded-sm border-2 transition-[transform,width,height] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
    style={{
      height: at.height,
      transform: `translate(${at.left}px, ${at.top}px)`,
      width: at.width,
    }}
  >
    {label === undefined ? null : (
      <span className="bg-status-running absolute bottom-full left-0 mb-1 max-w-64 truncate rounded px-1.5 py-0.5 text-xs font-medium text-white">
        {label}
      </span>
    )}
  </span>
);

/**
 * Comments over the live browser frame while recording: a numbered pin on
 * every element a comment was attached to, the outline of the one the
 * composer's list is pointing at, and inspect's element picker.
 *
 * Outside a pick the layer takes no pointer input, so the Page stays usable
 * underneath its pins. While picking, hovering outlines the element the Page
 * actually has under the pointer — the box comes from a Browser Snapshot, not
 * from hit-testing the bitmap the canvas is drawing — and a click attaches it
 * to the composer.
 */
export const InspectOverlay = ({
  canvas,
  onFreeze,
  onHover,
  projection,
  state,
}: {
  readonly canvas: HTMLCanvasElement | null;
  readonly onFreeze: (x: number, y: number) => void;
  readonly onHover: (x: number, y: number) => void;
  /** How the frame on the canvas maps onto the Page viewport it came from. */
  readonly projection: FrameProjection;
  readonly state: InspectState;
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const box = useCanvasBox(canvas, container);

  const pagePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return pagePointOf(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      projection,
      box
    );
  };

  const hovered =
    state.open && state.hovered !== undefined
      ? projectPageRectangle(state.hovered, projection, box)
      : undefined;
  const highlightedComment = state.comments.find(
    (comment) => comment.index === state.highlighted
  );

  return (
    <div
      className={
        state.open
          ? "absolute inset-0 cursor-crosshair"
          : "pointer-events-none absolute inset-0"
      }
      data-picking={state.open ? "" : undefined}
      onPointerDown={
        state.open
          ? (event) => {
              const point = pagePoint(event);
              onFreeze(point.x, point.y);
            }
          : undefined
      }
      onPointerMove={
        state.open
          ? (event) => {
              const point = pagePoint(event);
              onHover(point.x, point.y);
            }
          : undefined
      }
      ref={setContainer}
    >
      {highlightedComment === undefined ? null : (
        <Outline
          at={projectDocumentRectangle(highlightedComment, projection, box)}
        />
      )}
      {hovered === undefined || state.hovered === undefined ? null : (
        <Outline at={hovered} label={state.hovered.description} />
      )}
      {state.comments.map((comment) => (
        <Pin
          at={projectDocumentRectangle(comment, projection, box)}
          index={comment.index}
          key={comment.index}
        />
      ))}
      {state.open ? (
        <InspectHint
          error={
            state.error === undefined
              ? undefined
              : "Could not select this element. Try another visible element."
          }
          verb="Click"
        />
      ) : null}
    </div>
  );
};
