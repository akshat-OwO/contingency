import { AgentSessionId, FlowName } from "@contingency/protocol";
import type { IosWorkspaceSnapshot } from "@contingency/protocol";
import { expect, test } from "vitest";

import { iosDockPresentation } from "@/components/agent/ios-dock-state";

const pending = {
  assessment: null,
  captureGaps: [],
  captureState: null,
  cleanup: null,
  completedAt: null,
  controller: "user",
  error: null,
  field: null,
  flowName: FlowName.make("ios-login"),
  id: AgentSessionId.make("agent-ios"),
  kind: "teaching",
  observation: null,
  phase: "pending",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: { capabilities: [], platform: "ios" },
  revision: 0,
  selection: {
    device: {
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      kind: "simulator",
      name: "iPhone 17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      runtimeVersion: "26.5",
      udid: "11111111-2222-3333-4444-555555555555",
    },
    environment: {
      build: "1",
      bundleId: "dev.contingency.login",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtimeVersion: "26.5",
    },
    outcomes: [{ name: "Signed in", role: "text" }],
    setup: {
      conditions: [{ name: "Sign in", role: "button" }],
      kind: "restart-app",
    },
  },
  startedAt: "2026-11-27T00:00:00.000Z",
  takeoverOccurred: false,
} satisfies IosWorkspaceSnapshot;

test("retries a failed first preparation and recovers only after preparation", () => {
  expect(iosDockPresentation(pending).action?.label).toBe("Prepare simulator");
  const failed = iosDockPresentation({
    ...pending,
    error:
      "preparation_failed: iOS preparation_failed. Inspect this session and explicitly recover before input.",
    phase: "paused",
  });
  expect(failed.action).toEqual({
    accessibleName: "Retry preparation",
    gesture: "prepare",
    label: "Retry preparation",
  });
  expect(
    iosDockPresentation({
      ...pending,
      phase: "paused",
      preparation: {
        ...pending.preparation,
        evidence: [{ observationId: "ready", type: "observation" }],
      },
    }).action?.label
  ).toBe("Recover selected simulator");
});

test("retries a first preparation whose first observation named no app in front", () => {
  const refusal = {
    code: "foreground_app_unknown",
    recovery: "go-home",
  } as const;
  const unprepared = iosDockPresentation({
    ...pending,
    error:
      "iOS cannot tell which app is in front of the simulator, so nothing was observed or sent. Press Home (Go Home in the Workspace, or the recover command) and carry on from the Home Screen.",
    phase: "paused",
    refusal,
  });
  expect(unprepared.action?.label).toBe("Retry preparation");
  expect(unprepared.nextStep).toContain("Retry preparation");
  expect(unprepared.nextStep).not.toContain("Home");
  expect(
    iosDockPresentation({
      ...pending,
      phase: "paused",
      preparation: {
        ...pending.preparation,
        evidence: [{ observationId: "ready", type: "observation" }],
      },
      refusal,
    }).action?.label
  ).toBe("Go Home");
});
