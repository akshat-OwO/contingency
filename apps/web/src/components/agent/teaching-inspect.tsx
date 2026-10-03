import { MousePointerClickIcon } from "lucide-react";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

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
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

const Pin = ({
  at,
  index,
}: {
  readonly at: OverlayRectangle;
  readonly index: number;
}) => (
  <span
    className="bg-primary text-primary-foreground absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-xs font-semibold shadow-sm"
    style={{ left: at.left + at.width / 2, top: at.top }}
  >
    {index}
  </span>
);

const Outline = ({
  at,
  label,
}: {
  readonly at: OverlayRectangle;
  readonly label?: string | undefined;
}) => (
  <span
    className="pointer-events-none absolute block rounded-sm border-2 border-blue-500 bg-blue-500/20"
    style={{
      height: at.height,
      left: at.left,
      top: at.top,
      width: at.width,
    }}
  >
    {label === undefined ? null : (
      <span className="absolute bottom-full left-0 mb-1 max-w-64 truncate rounded bg-blue-500 px-1.5 py-0.5 text-xs font-medium text-white">
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
  onCancel,
  onFreeze,
  onHover,
  projection,
  state,
}: {
  readonly canvas: HTMLCanvasElement | null;
  readonly onCancel: () => void;
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
        <div
          className="bg-popover text-popover-foreground ring-foreground/10 absolute top-3 left-1/2 z-10 flex -translate-x-1/2 cursor-default items-center gap-2 rounded-full py-1 pr-1 pl-3 text-sm shadow-lg ring-1"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
        >
          <MousePointerClickIcon
            aria-hidden="true"
            className="size-4 text-blue-500"
          />
          <span>Click an element to attach it</span>
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
            <Kbd>Esc</Kbd>
          </Button>
        </div>
      ) : null}
      {state.open && state.error !== undefined ? (
        <p
          className="bg-background text-destructive pointer-events-none absolute top-16 left-1/2 z-10 max-w-sm -translate-x-1/2 rounded-md border p-3 text-sm shadow-lg"
          role="alert"
        >
          Could not select this element. Try another visible element or retry
          after the page finishes updating.
        </p>
      ) : null}
    </div>
  );
};
