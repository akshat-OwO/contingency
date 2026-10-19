import { BrowserStreamId, FrameSequence } from "@contingency/protocol";
import type { BrowserInput } from "@contingency/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Effect } from "effect";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  makeBrowserInputHandlers,
  mousePosition,
  renderFrame,
} from "@/components/browser/browser-input";

afterEach(cleanup);

test.each([
  [".", "Period", 190],
  ["-", "Minus", 189],
  ["'", "Quote", 222],
  ["%", "Digit5", 53],
  ["&", "Digit7", 55],
  ["(", "Digit9", 57],
  ["!", "Digit1", 49],
  ["@", "Digit2", 50],
  ["#", "Digit3", 51],
  ["$", "Digit4", 52],
  ['"', "Quote", 222],
  ["_", "Minus", 189],
  ["+", "Equal", 187],
  [":", "Semicolon", 186],
  ["?", "Slash", 191],
  [".", "NumpadDecimal", 110],
  ["1", "Numpad1", 97],
  ["a", "KeyA", 65],
  ["i", "KeyI", 73],
  ["é", "Unidentified", 0],
  ["Delete", "Delete", 46],
])("sends %s from %s with virtual key code %i", (key, code, expected) => {
  const inputs: BrowserInput[] = [];
  const handlers = makeBrowserInputHandlers((input) => inputs.push(input));
  const { getByRole } = render(
    createElement("canvas", {
      onKeyDown: (event) => handlers.handleKey(event, "keyDown"),
      onKeyUp: (event) => handlers.handleKey(event, "keyUp"),
      role: "img",
    })
  );
  const canvas = getByRole("img");

  fireEvent.keyDown(canvas, { code, key });
  fireEvent.keyUp(canvas, { code, key });

  const keyDown = {
    code,
    eventType: "keyDown",
    key,
    modifiers: 0,
    type: "input_keyboard",
    windowsVirtualKeyCode: expected,
  } as const;
  expect(inputs).toEqual([
    key.length === 1 ? { ...keyDown, text: key } : keyDown,
    {
      code,
      eventType: "keyUp",
      key,
      modifiers: 0,
      type: "input_keyboard",
      windowsVirtualKeyCode: expected,
    },
  ]);
});

test("maps a zoomed frame's displayed coordinates back to CSS pixels", async () => {
  const canvas = document.createElement("canvas");
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ close: vi.fn(), height: 200, width: 320 })
  );
  Object.defineProperty(canvas, "getContext", {
    value: () => ({ drawImage: vi.fn() }),
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 640, 400)
  );
  try {
    await Effect.runPromise(
      renderFrame(canvas, {
        data: new Uint8Array(),
        metadata: {
          deviceHeight: 800,
          deviceWidth: 1280,
          offsetTop: 0,
          pageScaleFactor: 4,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 0,
        },
        receivedAt: 0,
        seq: FrameSequence.make(1),
        streamId: BrowserStreamId.make("zoom-test"),
        type: "frame",
      })
    );
    expect(canvas.style.maxWidth).toBe("min(100%, 1280px)");
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(800);
    expect(mousePosition(canvas, { clientX: 320, clientY: 200 })).toEqual({
      x: 160,
      y: 100,
    });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
