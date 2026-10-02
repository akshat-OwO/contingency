import {
  AgentElementRef,
  AgentSnapshotId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";
import { teachingEventsFor } from "../../src/services/teaching-recorder.ts";

it("masks setup reflections in semantic evidence without declaring Flow Skill inputs", () => {
  const values = new Set(["x7", "replaced-private-code"]);
  const url = "https://shop.test/x7/replaced-private-code";
  const capture = makeDemonstrationCapture(url, () => [...values]);
  const at = "2026-10-02T00:00:00.000Z";
  const snapshotId = AgentSnapshotId.make("snapshot-setup");
  capture.recordSnapshot({
    capturedAt: at,
    nodes: [
      {
        depth: 0,
        name: "Code x7 and replaced-private-code",
        ref: AgentElementRef.make("e1"),
        role: "textbox",
        value: "x7",
      },
    ],
    snapshotId,
    title: "Account x7",
    url,
  });
  capture.recordInstruction("Reuse x7", at, "Code replaced-private-code");
  capture.recordAction({
    action: { ref: AgentElementRef.make("e1"), text: "x7", type: "fill" },
    actor: "user",
    at,
    description: "Fill with x7",
    detail: "Previous replaced-private-code",
    id: "user-edit",
    outcome: "completed",
    snapshotAfter: null,
    snapshotBefore: snapshotId,
    urlAfter: url,
    urlBefore: url,
  });
  const demonstration = capture.current();
  expect(demonstration.variables).toEqual([]);
  expect(demonstration.actions[0]?.action).toMatchObject({
    text: "[sensitive input]",
  });
  const events = teachingEventsFor(
    demonstration,
    {
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("default"),
      viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
    },
    at,
    at,
    "user"
  );
  expect(JSON.stringify(events)).not.toContain("x7");
  expect(JSON.stringify(events)).not.toContain("replaced-private-code");
  values.clear();
  expect(capture.sensitiveValues()).toEqual([]);
});
