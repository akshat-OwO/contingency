import { expect, it } from "vitest";

import {
  isModifierKey,
  keyDefinition,
  modifierMask,
  suppressesText,
} from "../../src/services/cdp-input";

it("builds the CDP modifier bitmask", () => {
  expect(modifierMask([])).toBe(0);
  expect(modifierMask(["Shift"])).toBe(8);
  expect(modifierMask(["Control"])).toBe(2);
  expect(modifierMask(["Control", "Shift"])).toBe(10);
  // A held non-modifier key contributes nothing to the mask.
  expect(modifierMask(["a", "Enter"])).toBe(0);
});

it("treats only the four modifiers as modifiers", () => {
  for (const key of ["Alt", "Control", "Meta", "Shift"]) {
    expect(isModifierKey(key)).toBe(true);
  }
  for (const key of ["Enter", "a", "ArrowUp", "shift"]) {
    expect(isModifierKey(key)).toBe(false);
  }
});

it("suppresses text under an accelerator modifier but not under Shift", () => {
  // Shift still produces a character; Control, Meta, and Alt make the
  // keystroke an accelerator, and sending text raises a spurious keypress.
  expect(suppressesText(["Shift"])).toBe(false);
  expect(suppressesText([])).toBe(false);
  expect(suppressesText(["Control"])).toBe(true);
  expect(suppressesText(["Meta"])).toBe(true);
  expect(suppressesText(["Alt"])).toBe(true);
  expect(suppressesText(["Control", "Shift"])).toBe(true);
});

it("describes the named keys a Recorder emits", () => {
  expect(keyDefinition("Enter")).toEqual({
    code: "Enter",
    keyCode: 13,
    text: "\r",
  });
  // A modifier inserts nothing.
  expect(keyDefinition("Shift")?.text).toBeUndefined();
  expect(keyDefinition("Tab")?.text).toBeUndefined();
});

it("derives a definition for a single printable character", () => {
  expect(keyDefinition("a")).toEqual({ code: "KeyA", keyCode: 65, text: "a" });
  expect(keyDefinition("7")).toEqual({
    code: "Digit7",
    keyCode: 55,
    text: "7",
  });
  // Multi-character names that are not in the table cannot be replayed.
  expect(keyDefinition("NotAKey")).toBeUndefined();
});
