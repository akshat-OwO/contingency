import { AgentSessionId, FlowSkillName } from "@contingency/protocol";
import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  actionableNodes,
  androidDockPresentation,
  androidSessionLabel,
} from "@/prototypes/android/presentation";

const pending = {
  assessment: null,
  captureGaps: [],
  captureState: null,
  cleanup: null,
  completedAt: null,
  controller: "user",
  error: null,
  experimental: true,
  flowSkillName: FlowSkillName.make("android-checkout"),
  id: AgentSessionId.make("agent-android"),
  kind: "teaching",
  observation: null,
  phase: "pending",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: { platform: "android", reversibleActions: [] },
  revision: 0,
  selection: {
    device: {
      api: 36,
      avd: "Pixel_9",
      fingerprint: "google/sdk",
      host: "local",
      serial: "emulator-5554",
    },
    environment: {
      androidVersion: "16",
      appBuild: "1",
      appId: "dev.contingency.checkout",
      startingState: "Signed out on Home",
    },
    helperConsent: "none",
    outcomes: [{ name: "Order placed", role: "text" }],
    reversibleActions: [],
    setup: {
      activity: ".MainActivity",
      conditions: [{ name: "Sign in", role: "button" }],
      kind: "restart-activity",
    },
  },
  startedAt: "2026-08-31T00:00:00.000Z",
  takeoverOccurred: false,
} satisfies AndroidWorkspaceSnapshot;

const running = {
  ...pending,
  phase: "running",
} satisfies AndroidWorkspaceSnapshot;

const gesture = (session: AndroidWorkspaceSnapshot) =>
  androidDockPresentation(session).action?.gesture;

test("labels Android sessions apart from browser ones", () => {
  expect(androidSessionLabel(pending)).toBe(
    "android-checkout · Android Teaching"
  );
  expect(androidSessionLabel({ ...pending, kind: "dry-run" })).toBe(
    "android-checkout · Android Dry Run"
  );
});

test("prepares the emulator before anything else", () => {
  expect(gesture(pending)).toBe("prepare");
});

test("waits on a Run Environment Permission instead of preparing", () => {
  const presentation = androidDockPresentation({
    ...pending,
    preparation: {
      ...pending.preparation,
      pending: [
        {
          id: "decision-1",
          kind: "run-environment-permission",
          targetApp: "dev.contingency.checkout",
        },
      ],
    },
  });
  expect(presentation.badge).toBe("Permission needed");
  expect(presentation.action).toBeNull();
});

test("recovers the same emulator after a pause", () => {
  expect(gesture({ ...pending, phase: "paused" })).toBe("recover");
});

test("starts and stops Teaching on the browser's names", () => {
  expect(gesture(running)).toBe("start-recording");
  const recording = androidDockPresentation({
    ...running,
    captureState: { _tag: "recording", startedAt: running.startedAt },
  });
  expect(recording.badge).toBe("Recording");
  expect(recording.action?.accessibleName).toBe("Stop recording");
  expect(recording.showsComment).toBe(true);
});

test("offers Takeover in an agent-driven Dry Run", () => {
  const dryRun = { ...running, controller: "agent", kind: "dry-run" } as const;
  expect(gesture(dryRun)).toBe("take-control");
  expect(gesture({ ...dryRun, controller: "user" })).toBe("return-control");
});

test("keeps Verify flow reachable after the Dry Run session closes", () => {
  const presentation = androidDockPresentation({
    ...pending,
    captureState: {
      _tag: "dry-run-passed",
      draftedAt: pending.startedAt,
      dryRunEndedAt: pending.startedAt,
      dryRunResult: {
        completedAt: pending.startedAt,
        inputs: [],
        observableOutcome: "Order placed",
        outcome: "passed",
      },
      dryRunSessionId: AgentSessionId.make("agent-dry-run"),
      dryRunStartedAt: pending.startedAt,
      readyAt: pending.startedAt,
      skillPath: "android-checkout/SKILL.md",
      startedAt: pending.startedAt,
      stoppedAt: pending.startedAt,
    },
    kind: "dry-run",
    phase: "closed",
  });
  expect(presentation.action?.gesture).toBe("verify-flow");
  expect(presentation.rejectable).toBe(true);
});

test("offers declared reversible controls and editable fields only", () => {
  const node = {
    covered: false,
    editable: false,
    name: "Sign in",
    password: false,
    role: "button",
    target: "n1",
  };
  const session = {
    ...running,
    observation: {
      capturedAt: running.startedAt,
      height: 2400,
      id: "o1",
      image: null,
      nodes: [
        node,
        { ...node, name: "Delete account", target: "n2" },
        { ...node, editable: true, name: "Name", target: "n3" },
        { ...node, editable: true, name: "PIN", password: true, target: "n4" },
      ],
      width: 1080,
    },
    requirements: {
      platform: "android",
      reversibleActions: [{ name: "Sign in", role: "button" }],
    },
  } satisfies AndroidWorkspaceSnapshot;
  expect(actionableNodes(session).map(({ target }) => target)).toEqual([
    "n1",
    "n3",
  ]);
});
