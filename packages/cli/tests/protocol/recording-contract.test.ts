import {
  RecordingPreStepArm,
  RecordingPreStepConditionArm,
  RecordingPreStepConditionUrl,
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
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionArm)({
      data: { index: 0, kind: "selectorVisible", scope: "step" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionUrl)({
      data: { index: 0, pattern: "/cart$", scope: "step" },
      type: "recording.pre-step.condition.url",
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
      data: { index: 0, kind: "selectorVisible", scope: "flow" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Success");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionArm)({
      data: { index: 0, kind: "selectorHidden", scope: "flow" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Success");
});

test("condition requests carry only the closed set of kinds and patterns", () => {
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionArm)({
      data: { index: 0, kind: "urlMatches", scope: "flow" },
      type: "recording.pre-step.condition.arm",
    })._tag
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(RecordingPreStepConditionUrl)({
      data: { index: 0, pattern: "", scope: "flow" },
      type: "recording.pre-step.condition.url",
    })._tag
  ).toBe("Failure");
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
