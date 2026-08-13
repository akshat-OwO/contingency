import {
  RecordingPreStepArm,
  RecordingPreStepConditionArm,
  RecordingSnapshot,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

test("step-scoped Pre-step requests require a Step id", () => {
  expect(
    Schema.decodeUnknownResult(RecordingPreStepArm)({
      data: { scope: "step" },
      type: "recording.pre-step.arm",
    })._tag
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepArm)({
      data: { scope: "step", stepId: "" },
      type: "recording.pre-step.arm",
    })._tag
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionArm)({
      data: { index: 0, scope: "step" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Failure");
});

test("Flow-scoped Pre-step requests omit a Step id", () => {
  expect(
    Schema.decodeUnknownResult(RecordingPreStepArm)({
      data: { scope: "flow" },
      type: "recording.pre-step.arm",
    })._tag
  ).toBe("Success");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionArm)({
      data: { index: 0, scope: "flow" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Success");
});

test("Recording snapshots reject invalid browser session identifiers", () => {
  expect(
    Schema.decodeUnknownResult(RecordingSnapshot)({
      captureMode: "ordinary",
      flow: {
        steps: [{ type: "navigate", url: "https://example.com" }],
        title: "Checkout",
      },
      initialUrl: "https://example.com",
      phase: "active",
      recordedSteps: [
        {
          id: "initial",
          preSteps: [],
          step: { type: "navigate", url: "https://example.com" },
        },
      ],
      revision: 1,
      sessionId: "not-a-create-session",
      tabId: "tab-1",
      undoAvailable: false,
    })._tag
  ).toBe("Failure");
});
