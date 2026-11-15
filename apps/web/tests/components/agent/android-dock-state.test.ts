import { AgentSessionId, FlowName } from "@contingency/protocol";
import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { expect, test } from "vitest";

import { androidDockPresentation } from "@/components/agent/android-dock-state";

const pending = {
  assessment: null,
  captureGaps: [],
  captureState: null,
  cleanup: null,
  completedAt: null,
  controller: "user",
  error: null,
  field: null,
  flowName: FlowName.make("android-checkout"),
  id: AgentSessionId.make("agent-android"),
  kind: "teaching",
  observation: null,
  phase: "pending",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: { capabilities: [], platform: "android" },
  revision: 0,
  selection: {
    device: {
      api: 36,
      avd: "Pixel_9",
      fingerprint: "Nothing/A059",
      host: "local",
      serial: "phone",
    },
    environment: {
      androidVersion: "16",
      appBuild: "1",
      appId: "dev.contingency.checkout",
      startingState: "Sign in is visible",
    },
    helperConsent: "none",
    outcomes: [{ name: "Order confirmed", role: "group" }],
    setup: {
      activity: "dev.contingency.checkout/.MainActivity",
      conditions: [{ name: "Sign in", role: "button" }],
      kind: "restart-activity",
    },
  },
  startedAt: "2026-10-15T00:00:00.000Z",
  takeoverOccurred: false,
} satisfies AndroidWorkspaceSnapshot;

test("offers initial preparation retry and recovery only after preparation", () => {
  const presentation = androidDockPresentation(pending);
  expect(presentation.action?.label).toBe("Prepare emulator");
  expect(presentation.nextStep).toContain("Prepare Pixel_9");
  expect(
    androidDockPresentation({ ...pending, phase: "paused" }).action?.label
  ).toBe("Retry preparation");
  expect(
    androidDockPresentation({
      ...pending,
      phase: "paused",
      preparation: {
        ...pending.preparation,
        evidence: [{ observationId: "ready", type: "observation" }],
      },
    }).action?.label
  ).toBe("Recover same emulator");
});

test("asks for taps on the screen while recording", () => {
  const recording = androidDockPresentation({
    ...pending,
    captureState: { _tag: "recording", startedAt: pending.startedAt },
    phase: "running",
  });
  expect(recording.nextStep).toContain("Tap through the journey");
  expect(recording.action?.accessibleName).toBe("Stop recording");
});

test("Confirmation pauses request a decision and preserve Takeover", () => {
  const session = {
    ...pending,
    boundary: {
      action: { action: '{"_tag":"activate","target":"@e1"}', type: "android" },
      description: "Place order",
      id: "boundary",
      operationId: "attempt",
      reason: "confirmation",
      requested: "Checkout",
    },
    phase: "paused",
  } satisfies AndroidWorkspaceSnapshot;
  const presentation = androidDockPresentation(session);
  expect(presentation.badge).toBe("Confirmation needed");
  expect(presentation.action?.gesture).toBe("return-control");
  expect(presentation.tone).toBe("attention");
  expect(
    androidDockPresentation({ ...session, controller: "agent" }).action?.gesture
  ).toBe("take-control");
});

test("an ended session's verdict sets its tone", () => {
  const verdict = (
    outcome: "blocked" | "inconclusive" | "not-working" | "working"
  ) =>
    androidDockPresentation({
      ...pending,
      assessment: { explanation: "Seen.", observationId: "final", outcome },
      kind: "run",
      phase: "completed",
    }).tone;
  expect(verdict("working")).toBe("success");
  expect(verdict("not-working")).toBe("failed");
  expect(verdict("blocked")).toBe("attention");
  expect(verdict("inconclusive")).toBe("attention");
  expect(
    androidDockPresentation({ ...pending, kind: "run", phase: "completed" })
      .tone
  ).toBe("default");
});

test("a recoverable pause asks for attention rather than failing", () => {
  expect(androidDockPresentation({ ...pending, phase: "paused" }).tone).toBe(
    "attention"
  );
  expect(androidDockPresentation({ ...pending, phase: "refused" }).tone).toBe(
    "failed"
  );
});

test("a driven session is live", () => {
  const running = { ...pending, kind: "run", phase: "running" } as const;
  expect(androidDockPresentation(running).tone).toBe("live");
  expect(
    androidDockPresentation({ ...running, controller: "agent" }).tone
  ).toBe("live");
});
