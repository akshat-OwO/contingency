import type { FrameProjection } from "@/components/agent/teaching-inspect-state";

/**
 * Where the canvas sits inside the box the inspect overlay is stretched over,
 * and how many of the canvas's CSS pixels one frame pixel occupies. The
 * Workspace centres a screencast scaled to fit a padded column, so the
 * overlay's own box is not the frame's box.
 */
export interface CanvasBox {
  readonly left: number;
  readonly scale: number;
  readonly top: number;
}

export const unscaledCanvasBox: CanvasBox = { left: 0, scale: 1, top: 0 };

/** One point, in whichever space the function taking it names. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

interface PageRectangle {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface OverlayRectangle {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * The overlay box one Page viewport rectangle covers. A Page rectangle is read
 * in CSS pixels of the layout viewport; the frame is that viewport at the
 * Page's visual zoom, starting `offsetTop` frame pixels below it, drawn at
 * `scale`.
 */
export const projectPageRectangle = (
  rectangle: PageRectangle,
  projection: FrameProjection,
  box: CanvasBox
): OverlayRectangle => ({
  height: rectangle.height * projection.pageScaleFactor * box.scale,
  left: box.left + rectangle.x * projection.pageScaleFactor * box.scale,
  top:
    box.top +
    (rectangle.y * projection.pageScaleFactor + projection.offsetTop) *
      box.scale,
  width: rectangle.width * projection.pageScaleFactor * box.scale,
});

/** The Page viewport point an overlay-box point is over: the inverse. */
export const pagePointOf = (
  point: Point,
  projection: FrameProjection,
  box: CanvasBox
): Point => ({
  x: (point.x - box.left) / box.scale / projection.pageScaleFactor,
  y:
    ((point.y - box.top) / box.scale - projection.offsetTop) /
    projection.pageScaleFactor,
});
