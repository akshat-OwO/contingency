import {
  AgentSessionId,
  CatalogRunSummary,
  FlowName,
} from "@contingency/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { catalogRunEntry } from "../../src/services/catalog-browser.ts";
import { nativeRunSummary } from "../../src/services/native-run-summary.ts";

const sessionId = AgentSessionId.make(`agent-android-${"c".repeat(32)}`);
const summary: Parameters<typeof nativeRunSummary>[0]["summary"] = {
  assessment: {
    explanation: "Home is visible.",
    observationId: "observation-2",
    outcome: "working",
  },
  captureGaps: [],
  flowName: FlowName.make("android-edit"),
  id: sessionId,
  kind: "run",
  phase: "completed",
  recordingId: null,
  requirements: {
    capabilities: ["semantic-actions", "screenshots"],
    environment: {
      androidVersion: "16",
      appBuild: "2",
      appId: "dev.fixture",
      startingState: "Home",
    },
    outcomes: [{ name: "Home", role: "text" }],
    platform: "android",
    preparation: {
      activity: "dev.fixture/.Home",
      conditions: [{ name: "Home", role: "text" }],
      kind: "restart-activity",
    },
  },
  startedAt: "2026-11-13T10:00:00.000Z",
  takeoverOccurred: false,
};
const ended = {
  endedAt: "2026-11-13T10:05:00.000Z",
  outcome: "completed" as const,
  platform: "android" as const,
  ran: true,
};

describe("native Run Summary", () => {
  it("is left only by a Run or Dry Run that ran", () => {
    expect(nativeRunSummary({ ...ended, summary })).toMatchObject({
      kind: "run",
      runId: `agentrun-${sessionId}`,
      schemaVersion: 4,
      sessionId,
      title: "Android Run · android-edit",
    });
    expect(
      nativeRunSummary({ ...ended, summary: { ...summary, kind: "teaching" } })
    ).toBeNull();
    expect(
      nativeRunSummary({ ...ended, summary: { ...summary, phase: "refused" } })
    ).toBeNull();
    expect(nativeRunSummary({ ...ended, ran: false, summary })).toBeNull();
  });

  it("round-trips and lists as a native Run in the Flows Drawer", () => {
    const written = nativeRunSummary({
      ...ended,
      platform: "ios",
      summary: { ...summary, kind: "dry-run" },
    });
    if (written === null) {
      throw new Error("A Dry Run that ran leaves a Run Summary.");
    }
    const codec = Schema.fromJsonString(CatalogRunSummary);
    const decoded = Schema.decodeUnknownSync(codec)(
      Schema.encodeSync(codec)(written)
    );
    expect(catalogRunEntry(decoded)).toMatchObject({
      assessment: "working",
      flowNames: ["android-edit"],
      kind: "dry-run",
      native: { platform: "ios", sessionId },
      outcome: "completed",
      title: "iOS Dry Run · android-edit",
    });
  });
});
