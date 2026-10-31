import type { BrowserModification } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import {
  BrowserModificationBadge,
  BrowserModifications,
} from "@/components/agent/browser-modifications";

afterEach(cleanup);
const changes: readonly BrowserModification[] = [
  {
    actor: "agent",
    at: "2026-10-18T12:00:00.000Z",
    description: "Mock **/api: 200 application/json, [redacted]",
    id: "route",
    kind: "route",
    operationId: "route",
    routeAction: "mock",
    source: "saved",
  },
  {
    actor: "agent",
    at: "2026-10-18T12:01:00.000Z",
    description: "Set text scale to 200%",
    id: "scale",
    kind: "emulation",
    operationId: "scale",
    textScale: 200,
  },
];
test("dock badge shows active modifications and disappears when all are removed", () => {
  const { rerender } = render(
    <BrowserModificationBadge modifications={changes} />
  );
  expect(
    screen.getByLabelText("Active Browser Modifications")
  ).toHaveTextContent("1 mocked route · 200% text");
  rerender(
    <BrowserModificationBadge
      modifications={changes.map((change) => ({
        ...change,
        removedAt: "2026-10-18T12:02:00.000Z",
      }))}
    />
  );
  expect(
    screen.queryByLabelText("Active Browser Modifications")
  ).not.toBeInTheDocument();
});
test("Summary retains redacted descriptions, activity times, and removal times", () => {
  if (changes[0] === undefined) {
    throw new Error("Missing fixture modification");
  }
  render(
    <BrowserModifications
      modifications={[
        ...changes,
        { ...changes[0], id: "removed", removedAt: "2026-10-18T12:03:00.000Z" },
      ]}
    />
  );
  const region = screen.getByRole("region", { name: "Browser Modifications" });
  expect(within(region).getAllByRole("listitem")).toHaveLength(3);
  expect(region).toHaveTextContent("[redacted]");
  expect(region).toHaveTextContent("Agent · Saved");
  expect(region).toHaveTextContent("Agent · Agent-initiated");
  expect(region).toHaveTextContent("2026-10-18T12:00:00.000Z");
  expect(region).toHaveTextContent("Removed 2026-10-18T12:03:00.000Z");
});

test("dock and Summary retain irreversible evaluation evidence", () => {
  const evaluated: BrowserModification = {
    actor: "agent",
    at: "2026-10-18T12:00:00.000Z",
    description: "Evaluated script: document.querySelector('#delete').click()",
    id: "eval",
    kind: "eval",
    operationId: "eval",
  };
  render(
    <>
      <BrowserModificationBadge modifications={[evaluated]} />
      <BrowserModifications modifications={[evaluated]} />
    </>
  );
  expect(
    screen.getByLabelText("Active Browser Modifications")
  ).toHaveTextContent("1 evaluation");
  expect(
    screen.getByRole("region", { name: "Browser Modifications" })
  ).toHaveTextContent(evaluated.description);
});
