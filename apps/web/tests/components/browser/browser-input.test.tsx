import type { BrowserInput } from "@contingency/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { makeBrowserInputHandlers } from "@/components/browser/browser-input";

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
