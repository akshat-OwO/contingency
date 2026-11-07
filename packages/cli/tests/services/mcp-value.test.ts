import { expect, test } from "vitest";

import { compactMcpValue } from "../../src/services/mcp-value.ts";

const snapshot = {
  browserCheckResults: [],
  capturedAt: "now",
  coverage: {
    nextCursor: null,
    offset: 0,
    returned: 1,
    selector: null,
    total: 1,
    truncated: false,
  },
  nodes: [],
  settle: { pending: [], settled: true },
  snapshotId: "s1",
  text: "button",
  url: "https://example.test",
};

test("omits full coverage and default fields without mutating evidence", () => {
  expect(compactMcpValue(snapshot)).toEqual({
    capturedAt: "now",
    snapshotId: "s1",
    text: "button",
    url: "https://example.test",
  });
  expect(snapshot.nodes).toEqual([]);
  expect(snapshot.coverage).toBeDefined();
});

test("keeps pagination, filtering, pending readiness, nodes, and failed checks", () => {
  for (const coverage of [
    { ...snapshot.coverage, nextCursor: "next", truncated: true },
    { ...snapshot.coverage, offset: 1 },
    { ...snapshot.coverage, selector: "main" },
    { ...snapshot.coverage, interactive: true },
    { ...snapshot.coverage, returned: 0 },
  ]) {
    const value = {
      ...snapshot,
      browserCheckResults: [{ outcome: "failed" }],
      coverage,
      nodes: [{ blockedBy: { name: "Consent", role: "dialog" } }],
      settle: { pending: ["request"], settled: false },
    };
    expect(compactMcpValue(value)).toEqual(value);
  }
});

test("removes only equal action duplicates and agent dispatch constants", () => {
  const value = {
    entry: {
      actor: "agent",
      at: "now",
      description: "Open cart",
      dispatched: true,
    },
    snapshot,
    url: snapshot.url,
  };
  expect(compactMcpValue(value, "Open cart")).toEqual({
    entry: { at: "now" },
    snapshot: { snapshotId: "s1", text: "button", url: snapshot.url },
  });
  const stopped = {
    entry: {
      actor: "user",
      at: "now",
      description: "Observed action",
      dispatched: false,
    },
    intervention: { boundaryId: "b1" },
    snapshot: { ...snapshot, capturedAt: "later" },
    url: "different",
  };
  expect(compactMcpValue(stopped, "Open cart")).toMatchObject({
    entry: stopped.entry,
    intervention: stopped.intervention,
    snapshot: { capturedAt: "later" },
    url: "different",
  });
});

test("preserves own __proto__ data keys through nested values and action copies", () => {
  const entries = Object.fromEntries([
    ["__proto__", "saved value"],
    ["normal", "kept"],
  ]);
  const value = {
    entries,
    entry: { ...entries, actor: "agent", at: "now", dispatched: true },
    nested: [entries],
    snapshot: { ...snapshot, ...entries },
  };
  const result = compactMcpValue(value);
  // Exercise the JSON transport as well as the in-memory projection.
  const serialized = JSON.stringify(result);
  expect(JSON.parse(serialized)).toEqual({
    entries,
    entry: { ...entries, at: "now" },
    nested: [entries],
    snapshot: {
      ...entries,
      snapshotId: "s1",
      text: "button",
      url: snapshot.url,
    },
  });
  expect(value.entry.actor).toBe("agent");
});

test("keeps matching URLs outside action results and full timeline entries", () => {
  const entry = {
    actor: "agent",
    at: "now",
    description: "Open cart",
    dispatched: true,
  };
  expect(
    compactMcpValue(
      { snapshot, timeline: [entry], url: snapshot.url },
      "Open cart"
    )
  ).toMatchObject({
    timeline: [entry],
    url: snapshot.url,
  });
});
