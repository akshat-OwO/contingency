import { Flow, SessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { makeRecordingService } from "../../src/services/recording";
import type { RecorderCapture } from "../../src/services/recording";

const sessionId = Schema.decodeUnknownSync(SessionId)("create-recording-test");

const makeCapture = () => {
  let emit: Parameters<RecorderCapture["start"]>[0]["onEvent"] | undefined;
  const capture: RecorderCapture = {
    start: (options) =>
      Effect.sync(() => {
        emit = options.onEvent;
        return Effect.void;
      }),
  };

  return {
    capture,
    emit: (event: Parameters<NonNullable<typeof emit>>[0]) => {
      if (emit === undefined) {
        throw new Error("Capture has not started");
      }
      return emit(event);
    },
  };
};

it.effect("finishes captured browser actions as a validated Flow", () => {
  const capture = makeCapture();

  return Effect.gen(function* recordFlow() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://www.1mg.com/pharmacy",
      sessionId,
      tabId: "tab-1",
      title: "Pharmacy",
    });
    yield* capture.emit({
      offsetX: 12,
      offsetY: 8,
      selectors: [["main", "button.buy"], "aria/Buy now"],
      type: "click",
    });

    const finished = yield* recording.finish();

    expect(finished.phase).toBe("finished");
    expect(finished.downloadName).toBe("1mg-pharmacy.json");
    expect(finished.flow.steps).toEqual([
      { type: "navigate", url: "https://www.1mg.com/pharmacy" },
      {
        offsetX: 12,
        offsetY: 8,
        selectors: [["main", "button.buy"], "aria/Buy now"],
        type: "click",
      },
    ]);
  });
});

it.effect("pauses capture and resumes into the pinned Recording", () => {
  const capture = makeCapture();

  return Effect.gen(function* pauseAndResume() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Checkout",
    });
    yield* recording.pause();
    yield* capture.emit({
      offsetX: 1,
      offsetY: 1,
      selectors: ["aria/I should not be captured"],
      type: "click",
    });
    const paused = yield* recording.get();
    expect(paused?.recordedSteps).toHaveLength(1);

    yield* recording.resume();
    yield* capture.emit({
      offsetX: 2,
      offsetY: 3,
      selectors: ["aria/Continue"],
      type: "click",
    });
    const active = yield* recording.get();
    expect(active?.recordedSteps).toHaveLength(2);
    expect(active?.sessionId).toBe(sessionId);
    expect(active?.tabId).toBe("tab-1");
  });
});

it.effect("serializes concurrently delivered capture events", () => {
  const capture = makeCapture();

  return Effect.gen(function* serializeEvents() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Concurrent capture",
    });
    yield* Effect.all(
      Array.from({ length: 20 }, (_, index) =>
        capture.emit({
          offsetX: index,
          offsetY: index,
          selectors: [`#action-${index}`],
          type: "click",
        })
      ),
      { concurrency: "unbounded" }
    );

    const active = yield* recording.get();
    expect(active?.recordedSteps).toHaveLength(21);
    expect(active?.revision).toBe(20);
  });
});

it.effect("fails closed when the pinned tab navigates while paused", () => {
  const capture = makeCapture();

  return Effect.gen(function* failPausedNavigation() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Checkout",
    });
    yield* recording.pause();
    const incomplete = yield* recording.recordNavigation(
      "https://example.com/other"
    );

    expect(incomplete.phase).toBe("incomplete");
    expect(incomplete.incompleteReason).toContain(
      "navigated while capture was paused"
    );
    expect(incomplete.recordedSteps).toHaveLength(1);
  });
});

it.effect("preserves the first failure reason during recorder cleanup", () => {
  const capture = makeCapture();

  return Effect.gen(function* preserveFailureReason() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Failure reason",
    });
    yield* recording.fail("A replayable selector could not be generated.");
    yield* recording.fail("Recorder connection closed.");
    const incomplete = yield* recording.get();

    expect(incomplete?.incompleteReason).toBe(
      "A replayable selector could not be generated."
    );
  });
});

it.effect("recovers from a deterministic navigation checkpoint", () => {
  const capture = makeCapture();

  return Effect.gen(function* recoverRecording() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/start",
      sessionId,
      tabId: "tab-1",
      title: "Recovery",
    });
    yield* capture.emit({
      offsetX: 2,
      offsetY: 3,
      selectors: ["aria/Continue"],
      type: "click",
    });
    yield* recording.fail("The original capture connection failed.");

    const recovered = yield* recording.recover(
      "https://example.com/checkpoint#private-fragment"
    );

    expect(recovered.phase).toBe("active");
    expect(recovered.incompleteReason).toBeUndefined();
    expect(recovered.recordedSteps).toHaveLength(3);
    expect(recovered.recordedSteps.at(-1)?.step).toEqual({
      type: "navigate",
      url: "https://example.com/checkpoint",
    });

    yield* capture.emit({
      offsetX: 4,
      offsetY: 5,
      selectors: ["aria/Recovered action"],
      type: "click",
    });
    const active = yield* recording.get();
    expect(active?.recordedSteps).toHaveLength(4);
  });
});

it.effect("authors conditional Pre-steps and ordered Audit Steps", () => {
  const capture = makeCapture();

  return Effect.gen(function* authorStepExtensions() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Checkout",
    });
    yield* capture.emit({
      offsetX: 3,
      offsetY: 4,
      selectors: ["aria/Checkout"],
      type: "click",
    });
    const active = yield* recording.get();
    const stepId = active?.recordedSteps[1]?.id;
    if (stepId === undefined) {
      return yield* Effect.die(new Error("Expected an authored Step"));
    }

    yield* recording.armPreStep({ stepId, type: "step" });
    yield* capture.emit({
      offsetX: 2,
      offsetY: 2,
      selectors: ["aria/Close popup"],
      type: "click",
    });
    yield* recording.armPreStepCondition({
      index: 0,
      stepId,
      type: "step",
    });
    yield* capture.emit({
      offsetX: 1,
      offsetY: 1,
      selectors: ["aria/Popup visible"],
      type: "click",
    });
    yield* recording.addAudit("accessibility");
    const finished = yield* recording.finish();

    expect(finished.flow.steps[1]).toMatchObject({
      contingency: {
        preSteps: [
          {
            step: { selectors: ["aria/Close popup"], type: "click" },
            when: {
              selectors: ["aria/Popup visible"],
              type: "selectorVisible",
            },
          },
        ],
      },
      type: "click",
    });
    expect(finished.flow.steps[2]).toEqual({
      name: "contingency.audit",
      parameters: { kind: "accessibility" },
      type: "customStep",
    });
  });
});

it.effect("attaches action-caused navigation without a duplicate Step", () => {
  const capture = makeCapture();

  return Effect.gen(function* reduceNavigation() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/products",
      sessionId,
      tabId: "tab-1",
      title: "Products",
    });
    yield* capture.emit({
      offsetX: 3,
      offsetY: 4,
      selectors: ["aria/Open product"],
      type: "click",
    });
    yield* capture.emit({
      causedByAction: true,
      type: "navigation",
      url: "https://example.com/products/1",
    });
    const active = yield* recording.get();

    expect(active?.recordedSteps).toHaveLength(2);
    expect(active?.recordedSteps[1]?.step).toMatchObject({
      assertedEvents: [
        {
          type: "navigation",
          url: "https://example.com/products/1",
        },
      ],
      type: "click",
    });
  });
});

it.effect("attaches late navigation events to the preceding action", () => {
  const capture = makeCapture();

  return Effect.gen(function* reduceNavigationAcrossAudit() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/products",
      sessionId,
      tabId: "tab-1",
      title: "Products",
    });
    yield* capture.emit({
      offsetX: 3,
      offsetY: 4,
      selectors: ["aria/Open product"],
      type: "click",
    });
    yield* recording.addAudit("accessibility");
    yield* capture.emit({
      causedByAction: true,
      type: "navigation",
      url: "https://example.com/products/1",
    });
    const active = yield* recording.get();

    expect(active?.recordedSteps).toHaveLength(3);
    expect(active?.recordedSteps[1]?.step).toMatchObject({
      assertedEvents: [
        {
          type: "navigation",
          url: "https://example.com/products/1",
        },
      ],
      type: "click",
    });
    expect(active?.recordedSteps[2]?.step.type).toBe("customStep");
  });
});

it.effect("retains sensitive changes using a Secret Variable only", () => {
  const capture = makeCapture();

  return Effect.gen(function* protectSensitiveInput() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId: "tab-1",
      title: "Sign in",
    });
    yield* capture.emit({
      secretVariable: "PASSWORD",
      selectors: ["input[type=password]"],
      type: "change",
      value: "{{PASSWORD}}",
    });
    const finished = yield* recording.finish();
    const serialized = JSON.stringify(finished.flow);

    expect(serialized).toContain("{{PASSWORD}}");
    expect(finished.flow.contingency?.secretVariables).toEqual([
      { name: "PASSWORD" },
    ]);
    expect(serialized).not.toContain("hunter2");
  });
});

it.effect("coalesces changes and resolves Secret Variable collisions", () => {
  const capture = makeCapture();

  return Effect.gen(function* coalesceChanges() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId: "tab-1",
      title: "Sign in",
    });
    yield* capture.emit({
      selectors: ["#password"],
      type: "change",
      value: "first",
    });
    yield* capture.emit({
      selectors: ["#password"],
      type: "change",
      value: "final",
    });
    yield* capture.emit({
      secretVariable: "PASSWORD",
      selectors: ["#new-password"],
      type: "change",
      value: "{{PASSWORD}}",
    });
    yield* capture.emit({
      secretVariable: "PASSWORD",
      selectors: ["#confirm-password"],
      type: "change",
      value: "{{PASSWORD}}",
    });
    const active = yield* recording.get();

    expect(active?.recordedSteps).toHaveLength(4);
    expect(active?.recordedSteps[1]?.step).toMatchObject({ value: "final" });
    expect(active?.flow.contingency?.secretVariables).toEqual([
      { name: "PASSWORD" },
      { name: "PASSWORD_2" },
    ]);
  });
});

it.effect("marks, renames, and reuses Secret Variables", () => {
  const capture = makeCapture();

  return Effect.gen(function* authorSecrets() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/profile",
      sessionId,
      tabId: "tab-1",
      title: "Profile",
    });
    yield* capture.emit({ selectors: ["#pin"], type: "change", value: "1234" });
    yield* capture.emit({
      selectors: ["#confirm-pin"],
      type: "change",
      value: "1234",
    });
    const draft = yield* recording.get();
    const firstId = draft?.recordedSteps[1]?.id;
    const secondId = draft?.recordedSteps[2]?.id;
    if (firstId === undefined || secondId === undefined) {
      return yield* Effect.die(new Error("Expected recorded changes"));
    }

    yield* recording.bindSecret(firstId, "pin");
    yield* recording.renameSecret("PIN", "ACCOUNT_PIN");
    const rebound = yield* recording.bindSecret(secondId, "ACCOUNT_PIN");

    expect(rebound.flow.contingency?.secretVariables).toEqual([
      { name: "ACCOUNT_PIN" },
    ]);
    expect(rebound.recordedSteps.slice(1).map(({ step }) => step)).toEqual([
      expect.objectContaining({ value: "{{ACCOUNT_PIN}}" }),
      expect.objectContaining({ value: "{{ACCOUNT_PIN}}" }),
    ]);
  });
});

it.effect("declares and renames Secret Variables used by Pre-steps", () => {
  const capture = makeCapture();

  return Effect.gen(function* protectPreStep() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId: "tab-1",
      title: "Sign in",
    });
    yield* capture.emit({
      offsetX: 2,
      offsetY: 3,
      selectors: ["#submit"],
      type: "click",
    });
    yield* recording.armPreStep({ type: "flow" });
    yield* capture.emit({
      secretVariable: "PASSWORD",
      selectors: ["#password"],
      type: "change",
      value: "{{PASSWORD}}",
    });
    const renamed = yield* recording.renameSecret("PASSWORD", "LOGIN_PASSWORD");

    expect(renamed.flow.contingency?.secretVariables).toEqual([
      { name: "LOGIN_PASSWORD" },
    ]);
    expect(renamed.flow.contingency?.preSteps?.[0]?.step).toMatchObject({
      value: "{{LOGIN_PASSWORD}}",
    });
  });
});

it.effect("deletes and restores a Step aggregate with one-level undo", () => {
  const capture = makeCapture();

  return Effect.gen(function* deleteAndUndo() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId: "tab-1",
      title: "Sign in",
    });
    yield* capture.emit({
      secretVariable: "PASSWORD",
      selectors: ["input[type=password]"],
      type: "change",
      value: "{{PASSWORD}}",
    });
    const active = yield* recording.get();
    const stepId = active?.recordedSteps[1]?.id;
    if (stepId === undefined) {
      return yield* Effect.die(new Error("Expected a sensitive Step"));
    }

    const deleted = yield* recording.deleteStep(stepId);
    expect(deleted.flow.contingency?.secretVariables).toBeUndefined();
    expect(deleted.undoAvailable).toBe(true);

    const restored = yield* recording.undoDelete();
    expect(restored.recordedSteps[1]?.id).toBe(stepId);
    expect(restored.flow.contingency?.secretVariables).toEqual([
      { name: "PASSWORD" },
    ]);
  });
});

it.effect("deletes and restores an ordered Audit Step", () => {
  const capture = makeCapture();

  return Effect.gen(function* deleteAndUndoAudit() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId: "tab-1",
      title: "Audit ordering",
    });
    const withAudit = yield* recording.addAudit("performance");
    const auditId = withAudit.recordedSteps[1]?.id;
    if (auditId === undefined) {
      return yield* Effect.die(new Error("Expected an Audit Step"));
    }

    const deleted = yield* recording.deleteStep(auditId);
    expect(deleted.recordedSteps).toHaveLength(1);
    const restored = yield* recording.undoDelete();
    expect(restored.recordedSteps[1]).toMatchObject({
      id: auditId,
      step: {
        name: "contingency.audit",
        parameters: { kind: "performance" },
        type: "customStep",
      },
    });
  });
});

it.effect(
  "sanitizes sensitive navigation data before retaining the Flow",
  () => {
    const capture = makeCapture();

    return Effect.gen(function* sanitizeNavigation() {
      const recording = yield* makeRecordingService(capture.capture);
      const active = yield* recording.start({
        initialUrl:
          "https://example.com/reset?token=sensitive&locale=en#temporary-secret",
        sessionId,
        tabId: "tab-1",
        title: "Reset password",
      });
      const serialized = JSON.stringify(active.flow);

      expect(serialized).toContain("token=%7B%7BTOKEN%7D%7D");
      expect(serialized).toContain("locale=en");
      expect(serialized).not.toContain("sensitive");
      expect(serialized).not.toContain("temporary-secret");
    });
  }
);

it.effect("accepts a plain Chrome Recorder compatible Flow", () =>
  Schema.decodeUnknownEffect(Flow)({
    steps: [
      { type: "navigate", url: "https://example.com" },
      {
        offsetX: 10,
        offsetY: 12,
        selectors: ["aria/Continue", ["main", "button"]],
        type: "click",
      },
    ],
    title: "Checkout",
  }).pipe(
    Effect.tap((flow) =>
      Effect.sync(() => {
        expect(flow.contingency).toBeUndefined();
        expect(flow.steps).toHaveLength(2);
      })
    )
  )
);
