import {
  AgentElementRef,
  AgentSnapshotId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type { AgentBrowserSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";
import { teachingEventsFor } from "../../src/services/teaching-recorder.ts";

const PAGE_URL = "https://shop.test/inventory";
const EMULATION = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("chrome-mac"),
  viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
} as const;

/** Two identical buttons, told apart only by the item each sits in. */
const inventory: AgentBrowserSnapshot = {
  capturedAt: "2026-09-24T00:00:00.000Z",
  nodes: [
    {
      depth: 0,
      name: "Inventory",
      ref: AgentElementRef.make("e1"),
      role: "main",
    },
    {
      context: "Sauce Labs Backpack",
      depth: 1,
      name: "Add to cart",
      ref: AgentElementRef.make("e2"),
      role: "button",
    },
    {
      context: "Sauce Labs Bolt T-Shirt",
      depth: 1,
      name: "Add to cart",
      ref: AgentElementRef.make("e3"),
      role: "button",
    },
    {
      depth: 0,
      name: "© 2026 Sauce Labs",
      ref: AgentElementRef.make("e4"),
      role: "contentinfo",
    },
  ],
  snapshotId: AgentSnapshotId.make("snapshot-inventory"),
  title: "Swag Labs",
  url: PAGE_URL,
};

const targetOfClick = (ref: string) => {
  const capture = makeDemonstrationCapture(PAGE_URL);
  capture.recordSnapshot(inventory);
  capture.recordAction({
    action: { ref: AgentElementRef.make(ref), type: "click" },
    actor: "user",
    at: "2026-09-24T00:00:01.000Z",
    description: 'Click button "Add to cart"',
    id: "user-click",
    outcome: "completed",
    snapshotAfter: null,
    snapshotBefore: inventory.snapshotId,
    urlAfter: PAGE_URL,
    urlBefore: PAGE_URL,
  });
  const action = teachingEventsFor(
    capture.current(),
    EMULATION,
    "2026-09-24T00:00:00.000Z",
    "2026-09-24T00:00:05.000Z",
    "user"
  ).find((event) => event._tag === "action");
  return action?.target;
};

it("records the item that tells a repeated control apart", () => {
  expect(targetOfClick("e3")?.context).toEqual([
    "Inventory",
    "Sauce Labs Bolt T-Shirt",
  ]);
  expect(targetOfClick("e2")?.context).toEqual([
    "Inventory",
    "Sauce Labs Backpack",
  ]);
});

it("takes context only from the target's own ancestors", () => {
  expect(targetOfClick("e4")?.context).toEqual([]);
});
