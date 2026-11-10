import { AgentElementRef, AgentSnapshotId } from "@contingency/protocol";
import type { AgentSnapshotNode } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  diffSnapshotLines,
  isWholePage,
  textSnapshot,
} from "../../src/services/agent-snapshot-text.ts";

const snapshotOf = (nodes: readonly AgentSnapshotNode[]) => ({
  capturedAt: "2026-10-02T00:00:00Z",
  nodes,
  snapshotId: AgentSnapshotId.make("snapshot-text"),
  title: "Cart",
  url: "https://example.test/cart",
});

test("renders references only on nodes an action can name", () => {
  const rendered = textSnapshot(
    snapshotOf([
      { depth: 0, name: "", ref: AgentElementRef.make("e1"), role: "main" },
      {
        depth: 1,
        name: "Cart",
        ref: AgentElementRef.make("e2"),
        role: "heading",
      },
      {
        checked: false,
        depth: 1,
        interactive: true,
        name: "Gift wrap",
        ref: AgentElementRef.make("e3"),
        role: "checkbox",
      },
      {
        clickable: true,
        context: "Backpack",
        depth: 1,
        name: "Sector 14",
        ref: AgentElementRef.make("e4"),
        role: "generic",
      },
      {
        depth: 1,
        interactive: true,
        name: "Help",
        ref: AgentElementRef.make("e5"),
        role: "link",
        url: "/help",
      },
      {
        depth: 1,
        interactive: true,
        name: "Password",
        ref: AgentElementRef.make("e6"),
        role: "textbox",
        valueWithheld: true,
      },
    ])
  );
  expect(rendered.nodes).toEqual([]);
  expect(rendered.text).toBe(
    [
      "main",
      '  heading "Cart"',
      '  @e3 checkbox "Gift wrap" [unchecked]',
      '  @e4 generic "Sector 14" [clickable context="Backpack"]',
      '  @e5 link "Help" [url=/help]',
      '  @e6 textbox "Password" [value withheld]',
    ].join("\n")
  );
});

test("diffs lines as a multiset so one more identical row is one addition", () => {
  const row = '@e2 button "Add to cart"';
  expect(
    diffSnapshotLines(
      ['heading "Cart"', row, row, 'paragraph "Total 2"'].join("\n"),
      ['heading "Cart"', row, row, row, 'paragraph "Total 3"'].join("\n")
    )
  ).toBe(
    [
      "diff: 2 added, 1 removed, 3 unchanged",
      `+ ${row}`,
      '+ paragraph "Total 3"',
      '- paragraph "Total 2"',
    ].join("\n")
  );
  expect(diffSnapshotLines("", "")).toBe(
    "diff: 0 added, 0 removed, 0 unchanged"
  );
});

test("compares only reads that saw the whole document", () => {
  const coverage = {
    nextCursor: null,
    offset: 0,
    returned: 1,
    selector: null,
    total: 1,
    truncated: false,
  };
  expect(isWholePage(snapshotOf([]))).toBe(true);
  expect(isWholePage({ ...snapshotOf([]), coverage })).toBe(true);
  expect(
    isWholePage({ ...snapshotOf([]), coverage: { ...coverage, offset: 300 } })
  ).toBe(false);
  expect(
    isWholePage({
      ...snapshotOf([]),
      coverage: { ...coverage, selector: "#bill" },
    })
  ).toBe(false);
  expect(
    isWholePage({
      ...snapshotOf([]),
      coverage: { ...coverage, interactive: true },
    })
  ).toBe(false);
  // Which nodes a truncated read holds moves with the viewport.
  expect(
    isWholePage({
      ...snapshotOf([]),
      coverage: { ...coverage, nextCursor: "next", truncated: true },
    })
  ).toBe(false);
});

test("keeps unnamed blockers explicit and compacts viewport bounds", () => {
  const node = {
    bounds: { height: 0, width: 375, x: 0, y: 72 },
    depth: 0,
    interactive: true,
    name: "",
    ref: AgentElementRef.make("e1"),
    role: "button",
  };
  expect(
    textSnapshot(
      snapshotOf([{ ...node, blockedBy: { name: "", role: "generic" } }])
    ).text
  ).toBe("button [blocked bounds=375x0@0,72]");
  expect(
    textSnapshot(
      snapshotOf([{ ...node, blockedBy: { name: "Consent", role: "dialog" } }])
    ).text
  ).toContain('blocked by dialog "Consent"');
});

test("names an Embedded Frame's host once, on its container", () => {
  const rendered = textSnapshot(
    snapshotOf([
      {
        depth: 0,
        frame: "js.payments.test",
        name: "Secure payment",
        ref: AgentElementRef.make("e1"),
        role: "frame",
      },
      {
        depth: 1,
        frame: "js.payments.test",
        interactive: true,
        name: "Card number",
        ref: AgentElementRef.make("e2"),
        role: "textbox",
      },
    ])
  );
  expect(rendered.text).toBe(
    [
      'frame "Secure payment" [host=js.payments.test]',
      '  @e2 textbox "Card number"',
    ].join("\n")
  );
});
