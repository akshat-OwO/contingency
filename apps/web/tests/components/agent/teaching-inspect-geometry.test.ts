import { expect, test } from "vitest";

import {
  pagePointOf,
  projectPageRectangle,
  unscaledCanvasBox,
} from "@/components/agent/teaching-inspect-geometry";
import { flatFrameProjection } from "@/components/agent/teaching-inspect-state";

const rectangle = { height: 40, width: 120, x: 20, y: 60 };

test("covers the element's own box when the frame is the viewport", () => {
  expect(
    projectPageRectangle(rectangle, flatFrameProjection, unscaledCanvasBox)
  ).toEqual({ height: 40, left: 20, top: 60, width: 120 });
});

test("draws over the frame the Page sent, not over an assumed viewport", () => {
  // The frame starts 24 of its own pixels below the top of the Page viewport,
  // the Page is pinched to 2x, and the canvas is drawn at half size. Leaving
  // the frame's offset out is what drew the highlight above its element (#212).
  expect(
    projectPageRectangle(
      rectangle,
      { offsetTop: 24, pageScaleFactor: 2 },
      { left: 8, scale: 0.5, top: 12 }
    )
  ).toEqual({ height: 40, left: 28, top: 84, width: 120 });
});

test("reads a pointer back to the Page point the highlight came from", () => {
  const projection = { offsetTop: 24, pageScaleFactor: 2 };
  const box = { left: 8, scale: 0.5, top: 12 };
  const projected = projectPageRectangle(rectangle, projection, box);
  expect(
    pagePointOf({ x: projected.left, y: projected.top }, projection, box)
  ).toEqual({ x: rectangle.x, y: rectangle.y });
});
