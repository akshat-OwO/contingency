import {
  AgentElementRef,
  AgentSnapshotId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentBrowserSnapshot,
  TeachingEvent,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";
import type { CapturedActionInput } from "../../src/services/teaching-capture.ts";
import { teachingEventsFor } from "../../src/services/teaching-recorder.ts";

const SHOP_URL = "https://shop.test/inventory";
const CART_URL = "https://shop.test/cart";
const STARTED_AT = "2026-09-24T00:00:00.000Z";
const EMULATION = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("chrome-mac"),
  viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
} as const;

const snapshotOf = (
  id: string,
  url: string,
  names: readonly string[]
): AgentBrowserSnapshot => ({
  capturedAt: STARTED_AT,
  nodes: names.map((name, index) => ({
    depth: 0,
    name,
    ref: AgentElementRef.make(`e${index + 1}`),
    role: "link",
  })),
  snapshotId: AgentSnapshotId.make(id),
  title: url,
  url,
});

const keystroke = (at: string, text: string): CapturedActionInput => ({
  action: { ref: AgentElementRef.make("e1"), text, type: "fill" },
  actor: "user",
  at,
  coalesceKey: "text-edit-sku",
  description: `Fill textbox "SKU" with "${text}"`,
  id: `user-input-${text}`,
  outcome: "completed",
  snapshotAfter: snapshotOf(`snapshot-${text}`, SHOP_URL, ["SKU"]),
  snapshotBefore: AgentSnapshotId.make("snapshot-start"),
  urlAfter: SHOP_URL,
  urlBefore: SHOP_URL,
});

const screenshot = (capturedAt: string, url = SHOP_URL) => ({
  capturedAt,
  encoding: "base64" as const,
  format: "png" as const,
  image: Buffer.from(capturedAt).toString("base64"),
  url,
});

const capturing = () => {
  const capture = makeDemonstrationCapture(SHOP_URL);
  capture.recordSnapshot(snapshotOf("snapshot-start", SHOP_URL, ["SKU"]));
  return capture;
};

/** The order a reader relies on, whatever the Demonstration held. */
const expectOrdered = (events: readonly TeachingEvent[]) => {
  expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index));
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1];
    if (previous !== undefined) {
      expect(event.at >= previous.at).toBe(true);
    }
    if (event._tag === "keyframe" && event.actionId !== null) {
      const action = events.findIndex(
        (candidate) =>
          candidate._tag === "action" && candidate.id === event.actionId
      );
      expect(action).toBeGreaterThanOrEqual(0);
      expect(action).toBeLessThan(index);
    }
  }
  expect(events.at(-1)?._tag).toBe("stopped");
};

it("places a typed field's keyframe after the fill it photographs", () => {
  const capture = capturing();
  const first = capture.recordAction(
    keystroke("2026-09-24T00:00:01.000Z", "A")
  );
  // Photographed after the first keystroke; the rest land inside the keyframe
  // interval, so none of them is photographed again.
  capture.recordKeyframe(screenshot("2026-09-24T00:00:01.050Z"), first.id);
  capture.recordAction(keystroke("2026-09-24T00:00:01.200Z", "AN"));
  capture.recordAction(keystroke("2026-09-24T00:00:01.300Z", "ANV"));
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    STARTED_AT,
    capture.stopTime("2026-09-24T00:00:02.000Z"),
    "user"
  );

  expectOrdered(events);
  expect(events.map(({ _tag }) => _tag)).toEqual([
    "started",
    "action",
    "keyframe",
    "stopped",
  ]);
  const fill = events.find((event) => event._tag === "action");
  expect(fill?.at).toBe("2026-09-24T00:00:01.000Z");
  expect(fill?.description).toBe('Fill textbox "SKU" with "ANV"');
});

it("keeps Stop after the keyframe it took of the open gesture", () => {
  const capture = capturing();
  const fill = capture.recordAction(keystroke("2026-09-24T00:00:01.000Z", "A"));
  capture.recordKeyframe(screenshot("2026-09-24T00:00:01.050Z"), fill.id);
  capture.recordAction(keystroke("2026-09-24T00:00:01.100Z", "AN"));
  // The user pressed Stop at 01.150; the photograph of what the gesture left
  // on the screen is only taken after that.
  capture.closeCoalescedAction(snapshotOf("snapshot-stop", SHOP_URL, ["SKU"]));
  capture.recordKeyframe(screenshot("2026-09-24T00:00:01.400Z"), fill.id);
  const stoppedAt = capture.stopTime("2026-09-24T00:00:01.150Z");
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    STARTED_AT,
    stoppedAt,
    "user"
  );

  expectOrdered(events);
  expect(stoppedAt > "2026-09-24T00:00:01.400Z").toBe(true);
  const keyframes = events.filter((event) => event._tag === "keyframe");
  expect(keyframes.map(({ at }) => at)).toEqual(["2026-09-24T00:00:01.400Z"]);
});

it("keeps the Page a navigating click started on as its before state", () => {
  const capture = capturing();
  const inventory = snapshotOf("snapshot-inventory", SHOP_URL, [
    "Cart",
    "Add Giant anvil to cart",
  ]);
  capture.recordSnapshot(inventory);
  const click = capture.recordAction({
    action: { ref: AgentElementRef.make("e1"), type: "click" },
    actor: "user",
    at: "2026-09-24T00:00:01.000Z",
    description: 'Click link "Cart"',
    id: "user-input-cart",
    outcome: "completed",
    snapshotAfter: snapshotOf("snapshot-cart", CART_URL, ["Checkout"]),
    snapshotBefore: inventory.snapshotId,
    urlAfter: CART_URL,
    urlBefore: SHOP_URL,
  });
  capture.recordKeyframe(
    screenshot("2026-09-24T00:00:01.300Z", CART_URL),
    click.id
  );
  const events = teachingEventsFor(
    capture.current(),
    EMULATION,
    STARTED_AT,
    capture.stopTime("2026-09-24T00:00:02.000Z"),
    "user"
  );

  expectOrdered(events);
  const action = events.find((event) => event._tag === "action");
  expect(action?.before).toEqual({
    nodeCount: 2,
    title: SHOP_URL,
    url: SHOP_URL,
  });
  expect(action?.after).toEqual({
    nodeCount: 1,
    title: CART_URL,
    url: CART_URL,
  });
  expect(action?.target?.name).toBe("Cart");
});
