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

/** A recording whose Dry Run has decided, with the given outcome. */
const decided = (_tag: "dry-run-failed" | "dry-run-passed") =>
  ({
    _tag,
    draftedAt: pending.startedAt,
    dryRunEndedAt: pending.startedAt,
    dryRunResult: {
      completedAt: pending.startedAt,
      inputs: [],
      observableOutcome: "The order was confirmed.",
      outcome: _tag === "dry-run-passed" ? "passed" : "failed",
    },
    dryRunSessionId: AgentSessionId.make("agent-dry-run"),
    dryRunStartedAt: pending.startedAt,
    readyAt: pending.startedAt,
    startedAt: pending.startedAt,
    stoppedAt: pending.startedAt,
  }) satisfies AndroidWorkspaceSnapshot["captureState"];

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

test("an ended Run reads Ended whatever its verdict, as the Web ended Run", () => {
  for (const outcome of [
    "blocked",
    "inconclusive",
    "not-working",
    "working",
  ] as const) {
    const presentation = androidDockPresentation({
      ...pending,
      assessment: { explanation: "Seen.", observationId: "final", outcome },
      kind: "dry-run",
      phase: "completed",
    });
    expect(presentation).toMatchObject({
      action: null,
      badge: "Ended",
      nextStep: "The Run ended. Its summary is beside it.",
      rejectable: false,
      tone: "ended",
    });
  }
  // A failed Dry Run's verdict is the Summary's, not the chip's.
  expect(
    androidDockPresentation({
      ...pending,
      captureState: decided("dry-run-failed"),
      kind: "dry-run",
      phase: "closed",
    })
  ).toMatchObject({ action: null, badge: "Ended", tone: "ended" });
});

test("an ended Dry Run keeps a Flow decision the recording waits on", () => {
  expect(
    androidDockPresentation({
      ...pending,
      captureState: decided("dry-run-passed"),
      kind: "dry-run",
      phase: "completed",
    })
  ).toMatchObject({
    action: { gesture: "verify-flow" },
    badge: "Ended",
    rejectable: true,
    tone: "ended",
  });
});

test("an ended Teaching session keeps its own verdict", () => {
  expect(androidDockPresentation({ ...pending, phase: "closed" }).badge).toBe(
    "Closed"
  );
});

test("a recoverable pause asks for attention rather than failing", () => {
  expect(androidDockPresentation({ ...pending, phase: "paused" }).tone).toBe(
    "attention"
  );
  expect(androidDockPresentation({ ...pending, phase: "refused" }).tone).toBe(
    "failed"
  );
});

test("the agent driving a Run reads Running; the user driving is live", () => {
  const running = { ...pending, kind: "run", phase: "running" } as const;
  expect(androidDockPresentation(running)).toMatchObject({
    badge: "You have control",
    tone: "live",
  });
  expect(
    androidDockPresentation({ ...running, controller: "agent" })
  ).toMatchObject({
    action: { gesture: "take-control" },
    badge: "Running",
    nextStep:
      "The agent is following the Flow on its own. Take control at any time; the agent waits until you return it.",
    tone: "busy",
  });
});
