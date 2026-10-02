import { useEffect, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";

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

const Pin = ({
  at,
  index,
}: {
  readonly at: OverlayRectangle;
  readonly index: number;
}) => (
  <span
    className="bg-primary text-primary-foreground absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-xs font-semibold"
    style={{ left: at.left + at.width / 2, top: at.top }}
  >
    {index}
  </span>
);

/**
 * Inspect mode over the live browser frame. Hovering highlights the element
 * the Page actually has under the pointer — the box comes from a Browser
 * Snapshot, not from hit-testing the bitmap the canvas is drawing — clicking
 * freezes it, and attaching records a Teaching instruction on the recording.
 */
export const InspectOverlay = ({
  canvas,
  onAttach,
  onCancel,
  onDraftChange,
  onExit,
  onHover,
  onFreeze,
  projection,
  state,
}: {
  readonly canvas: HTMLCanvasElement | null;
  readonly onAttach: () => void;
  readonly onCancel: () => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onExit: () => void;
  readonly onFreeze: (x: number, y: number) => void;
  readonly onHover: (x: number, y: number) => void;
  /** How the frame on the canvas maps onto the Page viewport it came from. */
  readonly projection: FrameProjection;
  readonly state: InspectState;
}) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const box = useCanvasBox(canvas, container);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onExit();
      }
    };
    globalThis.addEventListener("keydown", handleKey);
    return () => {
      globalThis.removeEventListener("keydown", handleKey);
    };
  }, [onExit]);

  const pagePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return pagePointOf(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      projection,
      box
    );
  };

  const highlighted = state.frozen ?? state.hovered;
  const highlight =
    highlighted === undefined
      ? undefined
      : projectPageRectangle(highlighted, projection, box);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onAttach();
  };

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      onPointerDown={(event) => {
        const point = pagePoint(event);
        onFreeze(point.x, point.y);
      }}
      onPointerMove={(event) => {
        if (state.frozen !== undefined) {
          return;
        }
        const point = pagePoint(event);
        onHover(point.x, point.y);
      }}
      ref={setContainer}
    >
      {state.error !== undefined && state.frozen === undefined ? (
        <p
          className="bg-background text-destructive pointer-events-none absolute top-3 left-1/2 z-10 max-w-sm -translate-x-1/2 rounded-md border p-3 text-sm shadow-lg"
          role="alert"
        >
          Could not select this element. Try another visible element or retry
          after the page finishes updating.
        </p>
      ) : null}
      {state.comments.map((comment) => (
        <Pin
          at={projectDocumentRectangle(comment, projection, box)}
          index={comment.index}
          key={comment.index}
        />
      ))}
      {highlight === undefined ? null : (
        <span
          className="pointer-events-none absolute block rounded-sm border-2 border-blue-500 bg-blue-500/20"
          style={{
            height: highlight.height,
            left: highlight.left,
            top: highlight.top,
            width: highlight.width,
          }}
        />
      )}
      {highlight === undefined || state.frozen === undefined ? null : (
        <form
          className="bg-background absolute z-10 w-72 space-y-2 rounded-lg border p-3 shadow-lg"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={submit}
          style={{
            left: Math.max(0, highlight.left),
            top: highlight.top + highlight.height + 8,
          }}
        >
          <p className="text-muted-foreground text-xs wrap-anywhere">
            {state.frozen.description}
          </p>
          <label className="block space-y-1 text-xs font-medium">
            Describe the change
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus */}
            <textarea
              autoFocus
              className="focus-visible:ring-ring h-20 w-full rounded-md border p-2 text-sm outline-none focus-visible:ring-2"
              onChange={(event) => onDraftChange(event.target.value)}
              value={state.draft}
            />
          </label>
          {state.error === undefined ? null : (
            <p className="text-destructive text-xs">{state.error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={state.pending || state.draft.trim() === ""}
              size="sm"
              type="submit"
            >
              Attach
            </Button>
          </div>
        </form>
      )}
    </div>
  );
};
