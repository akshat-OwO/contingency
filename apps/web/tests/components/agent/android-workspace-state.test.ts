import { expect, test } from "vitest";

import { parseReversibleActions } from "@/components/agent/android-workspace-state";

test("reads one reversible action per line", () => {
  expect(
    parseReversibleActions(
      "button: Sign in\n\n  button: Add Anvil to cart  \nbutton: Place mock order"
    )
  ).toEqual([
    { name: "Sign in", role: "button" },
    { name: "Add Anvil to cart", role: "button" },
    { name: "Place mock order", role: "button" },
  ]);
});

test("keeps colons inside the accessible name", () => {
  expect(parseReversibleActions("text: Cart: 1 item")).toEqual([
    { name: "Cart: 1 item", role: "text" },
  ]);
});

test("allows no reversible actions", () => {
  expect(parseReversibleActions("  \n")).toEqual([]);
});

test("rejects the list when any line is malformed", () => {
  expect(parseReversibleActions("button: Sign in\nOpen cart")).toBeUndefined();
  expect(parseReversibleActions("button:   ")).toBeUndefined();
});
