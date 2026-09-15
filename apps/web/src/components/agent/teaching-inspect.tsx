import { useEffect, useState } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";

import type { InspectState } from "@/components/agent/teaching-inspect-state";
import { Button } from "@/components/ui/button";

/**
 * How many CSS pixels of the canvas one Page pixel occupies. The Workspace
 * draws a screencast scaled to fit, so every Page rectangle has to be scaled
 * back before it can be drawn over the frame.
 */
const useCanvasScale = (canvas: HTMLCanvasElement | null): number => {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (canvas === null) {
      return;
    }
    const measure = () => {
      setScale(
        canvas.width === 0
          ? 1
          : canvas.getBoundingClientRect().width / canvas.width
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, [canvas]);
  return scale;
};

const Pin = ({
  index,
  scale,
  x,
  y,
}: {
  readonly index: number;
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}) => (
  <span
    className="bg-primary text-primary-foreground absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-xs font-semibold"
    style={{ left: x * scale, top: y * scale }}
  >
    {index}
  </span>
);

/**
 * Inspect mode over the live browser frame. Hovering outlines the element the
 * Page actually has under the pointer — the outline comes from a Browser
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
  state,
}: {
  readonly canvas: HTMLCanvasElement | null;
  readonly onAttach: () => void;
  readonly onCancel: () => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onExit: () => void;
  readonly onFreeze: (x: number, y: number) => void;
  readonly onHover: (x: number, y: number) => void;
  readonly state: InspectState;
}) => {
  const scale = useCanvasScale(canvas);

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
    return {
      x: (event.clientX - bounds.left) / scale,
      y: (event.clientY - bounds.top) / scale,
    };
  };

  const outlined = state.frozen ?? state.hovered;
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
    >
      {state.comments.map((comment) => (
        <Pin
          index={comment.index}
          key={comment.index}
          scale={scale}
          x={comment.x + comment.width / 2}
          y={comment.y}
        />
      ))}
      {outlined === undefined ? null : (
        <span
          className="ring-primary pointer-events-none absolute block rounded-sm ring-2"
          style={{
            height: outlined.height * scale,
            left: outlined.x * scale,
            top: outlined.y * scale,
            width: outlined.width * scale,
          }}
        />
      )}
      {state.frozen === undefined ? null : (
        <form
          className="bg-background absolute z-10 w-72 space-y-2 rounded-lg border p-3 shadow-lg"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={submit}
          style={{
            left: Math.max(0, state.frozen.x * scale),
            top: (state.frozen.y + state.frozen.height) * scale + 8,
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
