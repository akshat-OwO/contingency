import { AgentSessionId, FlowSkillName } from "@contingency/protocol";
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
  flowSkillName: FlowSkillName.make("android-checkout"),
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
      fingerprint: "Nothing/A059",
      host: "local",
      kind: "physical",
      model: "A059",
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
      kind: "clear-app-data",
    },
  },
  startedAt: "2026-10-15T00:00:00.000Z",
  takeoverOccurred: false,
} satisfies AndroidWorkspaceSnapshot;

test("names a phone a device, not an emulator", () => {
  const presentation = androidDockPresentation(pending);
  expect(presentation.action?.label).toBe("Prepare device");
  expect(presentation.nextStep).toContain("Prepare A059");
  expect(
    androidDockPresentation({ ...pending, phase: "paused" }).action?.label
  ).toBe("Recover same device");
});

test("asks for clicks on the screen while recording", () => {
  const recording = androidDockPresentation({
    ...pending,
    captureState: { _tag: "recording", startedAt: pending.startedAt },
    phase: "running",
  });
  expect(recording.nextStep).toContain("clicking the device screen");
  expect(recording.action?.accessibleName).toBe("Stop recording");
});
