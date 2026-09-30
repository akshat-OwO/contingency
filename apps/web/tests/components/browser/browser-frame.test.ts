import { BrowserStreamId, FrameSequence } from "@contingency/protocol";
import { Effect, Fiber, Result } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { projectPageRectangle } from "@/components/agent/teaching-inspect-geometry";
import { flatFrameProjection } from "@/components/agent/teaching-inspect-state";
import {
  canvasViewportSize,
  mousePosition,
  renderFrame,
} from "@/components/browser/browser-input";

const frame = {
  data: new Uint8Array([0]),
  metadata: {
    deviceHeight: 480,
    deviceWidth: 640,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    timestamp: 1,
  },
  seq: FrameSequence.make(1),
  streamId: BrowserStreamId.make("stream"),
  type: "frame" as const,
};

const renderer = () => {
  const canvas = document.createElement("canvas");
  const drawImage = vi.fn();
  const close = vi.fn();
  const bitmap = { close, height: 480, width: 640 };
  // SAFETY: renderFrame only uses drawImage on the canvas context.
  vi.spyOn(canvas, "getContext").mockReturnValue({
    drawImage,
  } as CanvasRenderingContext2D);
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  return { bitmap, canvas, close, drawImage };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("does not paint a frame whose stream changes while decoding", async () => {
  const { bitmap, canvas, close, drawImage } = renderer();
  const decoding = Promise.withResolvers<typeof bitmap>();
  const decode = vi.fn(() => decoding.promise);
  vi.stubGlobal("createImageBitmap", decode);
  let current = true;
  const rendered = Effect.runPromise(renderFrame(canvas, frame, () => current));
  expect(decode).toHaveBeenCalledOnce();
  current = false;
  decoding.resolve(bitmap);
  expect(await rendered).toBe(false);
  expect(drawImage).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test("closes a bitmap without painting after an interrupted decode", async () => {
  const { bitmap, canvas, close, drawImage } = renderer();
  const decoding = Promise.withResolvers<typeof bitmap>();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => decoding.promise)
  );
  const fiber = Effect.runFork(renderFrame(canvas, frame));
  await Effect.runPromise(Fiber.interrupt(fiber));
  decoding.resolve(bitmap);
  await decoding.promise;
  expect(drawImage).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test("reports decode failures instead of claiming a frame was painted", async () => {
  const { canvas } = renderer();
  const failure = new Error("Invalid JPEG");
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(failure));
  const outcome = await Effect.runPromise(
    Effect.result(renderFrame(canvas, frame))
  );
  expect(Result.isFailure(outcome)).toBe(true);
  if (Result.isFailure(outcome)) {
    expect(outcome.failure).toBe(failure);
  }
});

test("closes the bitmap when drawing fails", async () => {
  const { canvas, close, drawImage } = renderer();
  drawImage.mockImplementation(() => {
    throw new Error("Draw failed");
  });
  const outcome = await Effect.runPromise(
    Effect.result(renderFrame(canvas, frame))
  );
  expect(Result.isFailure(outcome)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

test("paints at the viewport size without resetting an unchanged canvas", async () => {
  const { canvas, close, drawImage } = renderer();
  canvas.width = 640;
  canvas.height = 480;
  const width = vi.spyOn(canvas, "width", "set");
  const height = vi.spyOn(canvas, "height", "set");
  expect(await Effect.runPromise(renderFrame(canvas, frame))).toBe(true);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(width).not.toHaveBeenCalled();
  expect(height).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test.each([2, 3])(
  "keeps %sx bitmap detail and maps pointers and inspect to logical pixels",
  async (density) => {
    const { bitmap, canvas } = renderer();
    bitmap.width = 640 * density;
    bitmap.height = 480 * density;
    await Effect.runPromise(renderFrame(canvas, frame));
    expect(canvas.width).toBe(640 * density);
    expect(canvas.height).toBe(480 * density);
    expect(canvas.style.maxWidth).toBe("min(100%, 640px)");
    expect(canvas.style.maxHeight).toBe("min(100%, 480px)");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 10, 320, 240)
    );
    expect(mousePosition(canvas, { clientX: 180, clientY: 130 })).toEqual({
      x: 320,
      y: 240,
    });
    const viewport = canvasViewportSize(canvas);
    expect(
      projectPageRectangle(
        { height: 20, width: 40, x: 320, y: 240 },
        flatFrameProjection,
        {
          left: 20,
          scale: 320 / viewport.width,
          top: 10,
        }
      )
    ).toEqual({ height: 10, left: 180, top: 130, width: 20 });
  }
);
