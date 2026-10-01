import { useEffect, useState } from "react";

import type { CanvasBox } from "@/components/agent/teaching-inspect-geometry";
import { unscaledCanvasBox } from "@/components/agent/teaching-inspect-geometry";
import { canvasViewportSize } from "@/components/browser/browser-input";

/**
 * Where the frame is, inside the box the overlay stretches over. The canvas is
 * centred in a padded column and scaled to fit it, so neither its origin nor
 * its scale is the overlay's own; both are measured from the live elements and
 * re-measured whenever the column, the canvas box, or the frame's own pixel
 * size changes.
 */
export const useCanvasBox = (
  canvas: HTMLCanvasElement | null,
  container: HTMLElement | null
): CanvasBox => {
  const [box, setBox] = useState<CanvasBox>(unscaledCanvasBox);
  useEffect(() => {
    if (canvas === null || container === null) {
      return;
    }
    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      const origin = container.getBoundingClientRect();
      const viewport = canvasViewportSize(canvas);
      const next: CanvasBox = {
        left: bounds.left - origin.left,
        scale:
          viewport.width === 0 || bounds.width === 0
            ? 1
            : bounds.width / viewport.width,
        top: bounds.top - origin.top,
      };
      setBox((current) =>
        current.left === next.left &&
        current.scale === next.scale &&
        current.top === next.top
          ? current
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(container);
    // A frame of a new size rewrites the canvas's `width` and `height`
    // attributes, which changes how many CSS pixels one frame pixel occupies
    // even when the element's own box does not move.
    const attributes = new MutationObserver(measure);
    attributes.observe(canvas, {
      attributeFilter: ["height", "width"],
      attributes: true,
    });
    globalThis.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      attributes.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [canvas, container]);
  return box;
};
