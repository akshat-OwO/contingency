import { AgentElementRef, AgentSnapshotId } from "@contingency/protocol";
import type { AgentBrowserSnapshot } from "@contingency/protocol";
import { expect, it } from "vitest";

import { quotedOutcome } from "../../src/services/mcp-pursuit.ts";

const page = (...names: readonly string[]): AgentBrowserSnapshot => ({
  browserCheckResults: [],
  capturedAt: "2026-10-08T00:00:00.000Z",
  nodes: names.map((name, index) => ({
    depth: 0,
    name,
    ref: AgentElementRef.make(`e${index + 1}`),
    role: "status",
  })),
  snapshotId: AgentSnapshotId.make("snapshot-quoted"),
  title: "Shop",
  url: "http://ridgeline.localhost/",
});

it("reads quoted outcome text from the Page", () => {
  const doneWhen = 'The status line reads "Delivering to: Highlands, Denver".';
  expect(
    quotedOutcome(doneWhen, page("Delivering to: Highlands, Denver"))
  ).toBe(true);
  expect(
    quotedOutcome(doneWhen, page("Delivering to: No delivery location chosen"))
  ).toBe(false);
});

it("ignores case, spacing, and a closing full stop", () => {
  expect(
    quotedOutcome(
      'The status line reads "Trail Hammer  added to cart."',
      page("trail hammer added to cart.")
    )
  ).toBe(true);
});

it("needs every quoted phrase, curly quotes included", () => {
  const doneWhen = "Shows “Your cart” and “Pearl Street, Boulder”.";
  expect(quotedOutcome(doneWhen, page("Your cart"))).toBe(false);
  expect(
    quotedOutcome(doneWhen, page("Your cart", "Pearl Street, Boulder"))
  ).toBe(true);
});

it("leaves unquoted outcomes and absences to System One", () => {
  expect(quotedOutcome("The banner is gone.", page())).toBeUndefined();
  expect(quotedOutcome("The cart lists nothing.", page())).toBeUndefined();
  expect(quotedOutcome("The cart lists the hammer.", page())).toBeUndefined();
});

it("reads a quoted phrase that itself says no", () => {
  expect(
    quotedOutcome(
      'The status reads "No delivery location chosen".',
      page("No delivery location chosen")
    )
  ).toBe(true);
});

it("reads quoted text that must be gone", () => {
  const doneWhen = 'The "Demo fault" banner is no longer shown.';
  expect(quotedOutcome(doneWhen, page("Demo fault", "Restore"))).toBe(false);
  expect(quotedOutcome(doneWhen, page("Your cart"))).toBe(true);
});

it("matches whole words, not parts of them", () => {
  const doneWhen = 'The cart line reads "1 item".';
  expect(quotedOutcome(doneWhen, page("Cart: 11 items"))).toBe(false);
  expect(quotedOutcome(doneWhen, page("Cart: 1 item"))).toBe(true);
  expect(quotedOutcome(doneWhen, page("Cart (1 item)"))).toBe(true);
});

it("confirms only a phrase the step brought about", () => {
  const doneWhen = 'The status line names "Trail Hammer".';
  const start = page("Trail Hammer", "Add Trail Hammer to cart");
  expect(
    quotedOutcome(
      doneWhen,
      page("Trail Hammer", "Cedar Pull Saw added to cart"),
      start
    )
  ).toBeUndefined();
  expect(
    quotedOutcome(
      'The status line reads "Trail Hammer added to cart".',
      page("Trail Hammer", "Trail Hammer added to cart"),
      start
    )
  ).toBe(true);
});

it("confirms an absence only for text shown when the step started", () => {
  const doneWhen = 'The "Demo fault" banner is no longer shown.';
  expect(
    quotedOutcome(doneWhen, page("Your cart"), page("Your cart"))
  ).toBeUndefined();
  expect(
    quotedOutcome(doneWhen, page("Your cart"), page("Demo fault", "Restore"))
  ).toBe(true);
});
