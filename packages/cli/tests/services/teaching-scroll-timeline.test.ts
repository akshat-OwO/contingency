import {
  AgentElementRef,
  AgentSnapshotId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type { AgentBrowserSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";
import type { CapturedActionInput } from "../../src/services/teaching-capture.ts";
import { teachingEventsFor } from "../../src/services/teaching-recorder.ts";

const PAGE_URL = "https://shop.test/catalog";
const EMULATION = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("chrome-mac"),
  viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
} as const;
const SCROLL_KEY = "user-scroll";

const snapshotWith = (
  id: string,
  names: readonly string[]
): AgentBrowserSnapshot => ({
  capturedAt: "2026-09-18T00:00:00.000Z",
  nodes: names.map((name, index) => ({
    depth: 0,
    name,
    ref: AgentElementRef.make(`e${index + 1}`),
    role: "button",
  })),
  snapshotId: AgentSnapshotId.make(id),
  title: "Catalog",
  url: PAGE_URL,
});

const scrollInput = (at: string, index: number): CapturedActionInput => ({
  action: {
    input: { eventType: "mouseWheel", inputType: "mouse" },
    type: "input",
  },
  actor: "user",
  at,
  coalesceKey: SCROLL_KEY,
  description: "The user scrolled the Page",
  id: `user-input-scroll-${index}`,
  outcome: "completed",
  snapshotAfter: null,
  snapshotBefore: AgentSnapshotId.make("snapshot-start"),
  urlAfter: PAGE_URL,
  urlBefore: PAGE_URL,
});

const clickInput = (
  at: string,
  snapshot: AgentBrowserSnapshot
): CapturedActionInput => ({
  action: { ref: AgentElementRef.make("e1"), type: "click" },
  actor: "user",
  at,
  description: "The user clicked Add to cart",
  id: "user-input-click",
  outcome: "completed",
  snapshotAfter: snapshot,
  snapshotBefore: snapshot.snapshotId,
  urlAfter: PAGE_URL,
  urlBefore: PAGE_URL,
});

const fillInput = (at: string, index: number): CapturedActionInput => ({
  action: {
    ref: AgentElementRef.make(`e${index + 1}`),
    text: "ANVIL-1",
    type: "fill",
  },
  actor: "user",
  at,
  coalesceKey: "field-sku",
  description: "The user filled SKU",
  id: `user-input-fill-${index}`,
  outcome: "completed",
  snapshotAfter: snapshotWith(`snapshot-fill-${index}`, ["Add to cart"]),
  snapshotBefore: AgentSnapshotId.make("snapshot-start"),
  urlAfter: PAGE_URL,
  urlBefore: PAGE_URL,
});

const capturing = () => {
  const capture = makeDemonstrationCapture(PAGE_URL);
  capture.recordSnapshot(snapshotWith("snapshot-start", ["Add to cart"]));
  return capture;
};

it("keeps one scroll gesture as one captured action", () => {
  const capture = capturing();
  for (let index = 0; index < 72; index += 1) {
    capture.recordAction(
      scrollInput(`2026-09-18T00:00:0${index % 10}.000Z`, index)
    );
  }
  const { actions } = capture.current();

  expect(actions).toHaveLength(1);
  expect(actions[0]?.id).toBe("user-input-scroll-0");
});

it("separates scroll gestures broken by another action", () => {
  const capture = capturing();
  const settled = snapshotWith("snapshot-settled", ["Add to cart"]);
  capture.recordAction(scrollInput("2026-09-18T00:00:00.000Z", 0));
  capture.recordAction(scrollInput("2026-09-18T00:00:01.000Z", 1));
  capture.recordAction(clickInput("2026-09-18T00:00:02.000Z", settled));
  capture.recordAction(scrollInput("2026-09-18T00:00:03.000Z", 2));
  const { actions } = capture.current();

  expect(actions).toHaveLength(3);
  expect(actions.map(({ id }) => id)).toEqual([
    "user-input-scroll-0",
    "user-input-click",
    "user-input-scroll-2",
  ]);
});

it("closes a scroll gesture with what the next action observed", () => {
  const capture = capturing();
  const settled = snapshotWith("snapshot-settled", [
    "Add to cart",
    "Load more",
  ]);
  capture.recordAction(scrollInput("2026-09-18T00:00:00.000Z", 0));
  capture.recordAction(scrollInput("2026-09-18T00:00:01.000Z", 1));
  capture.recordAction(clickInput("2026-09-18T00:00:02.000Z", settled));
  const [scroll] = capture.current().actions;

  expect(scroll?.snapshotAfter).toBe("snapshot-settled");
});

it("closes a scroll gesture the recording stopped in the middle of", () => {
  const capture = capturing();
  capture.recordAction(scrollInput("2026-09-18T00:00:00.000Z", 0));
  capture.closeCoalescedAction(
    snapshotWith("snapshot-stopped", ["Add to cart"])
  );
  const [scroll] = capture.current().actions;

  expect(scroll?.snapshotAfter).toBe("snapshot-stopped");
});

it("leaves consecutive text edits coalescing on their own observation", () => {
  const capture = capturing();
  capture.recordAction(fillInput("2026-09-18T00:00:00.000Z", 0));
  capture.recordAction(fillInput("2026-09-18T00:00:01.000Z", 1));
  const { actions } = capture.current();

  expect(actions).toHaveLength(1);
  expect(actions[0]?.id).toBe("user-input-fill-0");
  expect(actions[0]?.snapshotAfter).toBe("snapshot-fill-1");
});

it("opens a gesture the next scroll notch coalesces into", () => {
  const capture = capturing();

  expect(capture.openCoalesceKey()).toBeUndefined();
  capture.recordAction(scrollInput("2026-09-18T00:00:00.000Z", 0));
  expect(capture.openCoalesceKey()).toBe(SCROLL_KEY);
  capture.recordAction(
    clickInput(
      "2026-09-18T00:00:01.000Z",
      snapshotWith("snapshot-settled", ["Add to cart"])
    )
  );
  expect(capture.openCoalesceKey()).toBeUndefined();
});

/**
 * The session observes the Page on a gesture's first notch, so this is the
 * fallback: an after tree alone still names nothing, because a diff against an
 * absent before would be invented rather than observed.
 */
it("names nothing for a gesture that never observed where it started", () => {
  const capture = makeDemonstrationCapture(PAGE_URL);
  capture.recordAction({
    ...scrollInput("2026-09-18T00:00:00.000Z", 0),
    snapshotBefore: null,
  });
  capture.closeCoalescedAction(
    snapshotWith("snapshot-stopped", ["Add to cart", "Load more"])
  );
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:05.000Z",
    "user"
  );
  const action = events.find((event) => event._tag === "action");

  expect(action?.after.nodeCount).toBe(2);
  expect(action?.appeared).toEqual([]);
  expect(action?.disappeared).toEqual([]);
});

it("reports no change for an action whose after state was never captured", () => {
  const capture = capturing();
  capture.recordAction({
    ...scrollInput("2026-09-18T00:00:00.000Z", 0),
    coalesceKey: undefined,
  });
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:05.000Z",
    "user"
  );
  const action = events.find((event) => event._tag === "action");

  expect(action?.disappeared).toEqual([]);
  expect(action?.appeared).toEqual([]);
});

it("reports what a closed scroll gesture actually revealed", () => {
  const capture = capturing();
  capture.recordAction(scrollInput("2026-09-18T00:00:00.000Z", 0));
  capture.closeCoalescedAction(
    snapshotWith("snapshot-stopped", ["Add to cart", "Load more"])
  );
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:05.000Z",
    "user"
  );
  const action = events.find((event) => event._tag === "action");

  expect(action?.disappeared).toEqual([]);
  expect(action?.appeared).toEqual([{ name: "Load more", role: "button" }]);
});
