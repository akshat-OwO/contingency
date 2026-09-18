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
const FIELD_KEY = "field-sku";

/** The field as the user found it: focused, named, and still empty. */
const fieldSnapshot = (id: string, value: string): AgentBrowserSnapshot => ({
  capturedAt: "2026-09-18T00:00:00.000Z",
  nodes: [
    {
      depth: 0,
      name: "SKU",
      ref: AgentElementRef.make("e1"),
      role: "textbox",
      value,
    },
  ],
  snapshotId: AgentSnapshotId.make(id),
  title: "Catalog",
  url: PAGE_URL,
});

const fillInput = (
  at: string,
  index: number,
  text: string
): CapturedActionInput => ({
  action: { ref: AgentElementRef.make("e1"), text, type: "fill" },
  actor: "user",
  at,
  coalesceKey: FIELD_KEY,
  description: `Fill textbox "SKU" with "${text}"`,
  id: `user-input-fill-${index}`,
  outcome: "completed",
  snapshotAfter: fieldSnapshot(`snapshot-fill-${index}`, text),
  snapshotBefore: AgentSnapshotId.make("snapshot-start"),
  urlAfter: PAGE_URL,
  urlBefore: PAGE_URL,
});

const capturing = () => {
  const capture = makeDemonstrationCapture(PAGE_URL);
  capture.recordSnapshot(fieldSnapshot("snapshot-start", ""));
  return capture;
};

const timelineOf = (capture: ReturnType<typeof capturing>) =>
  teachingEventsFor(
    capture.current(),
    EMULATION,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:05.000Z",
    "user"
  );

it("records the value a fill landed on its target", () => {
  const capture = capturing();
  capture.recordAction(fillInput("2026-09-18T00:00:01.000Z", 0, "ANVIL-1"));
  const action = timelineOf(capture).find((event) => event._tag === "action");

  expect(action?.target?.role).toBe("textbox");
  expect(action?.target?.name).toBe("SKU");
  expect(action?.target?.value).toBe("ANVIL-1");
  expect(action?.target?.valueWithheld).toBe(false);
  expect(action?.description).toBe('Fill textbox "SKU" with "ANVIL-1"');
});

it("records a private Variable as its placeholder, not its literal", () => {
  const capture = capturing();
  capture.recordVariable(
    { name: "ACCOUNT_ID", runtime: true, secret: true },
    "4242-4242",
    "#sku"
  );
  capture.recordAction({
    ...fillInput("2026-09-18T00:00:01.000Z", 0, "{{ACCOUNT_ID}}"),
    description: 'Enter Variable ACCOUNT_ID in textbox "SKU"',
    snapshotAfter: fieldSnapshot("snapshot-fill-0", "{{ACCOUNT_ID}}"),
  });
  const events = timelineOf(capture);
  const action = events.find((event) => event._tag === "action");

  expect(action?.target?.value).toBe("{{ACCOUNT_ID}}");
  expect(action?.target?.valueWithheld).toBe(true);
  expect(JSON.stringify(events)).not.toContain("4242-4242");
});

it("tells an empty field apart from a withheld value", () => {
  const capture = capturing();
  capture.recordAction(fillInput("2026-09-18T00:00:01.000Z", 0, ""));
  const action = timelineOf(capture).find((event) => event._tag === "action");

  expect(action?.target?.value).toBe("");
  expect(action?.target?.valueWithheld).toBe(false);
});

it("carries the final value of coalesced text edits", () => {
  const capture = capturing();
  capture.recordAction(fillInput("2026-09-18T00:00:01.000Z", 0, "ANV"));
  capture.recordAction(fillInput("2026-09-18T00:00:02.000Z", 1, "ANVIL-1"));
  const actions = timelineOf(capture).filter(
    (event) => event._tag === "action"
  );

  expect(actions).toHaveLength(1);
  expect(actions[0]?.target?.value).toBe("ANVIL-1");
});
