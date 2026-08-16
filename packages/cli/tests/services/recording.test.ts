import { BrowserTabId, Flow, SessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  flowDownloadName,
  makeRecordingService,
} from "../../src/services/recording";
import type { RecorderCapture } from "../../src/services/recording";

const sessionId = Schema.decodeUnknownSync(SessionId)("create-recording-test");
const tabId = Schema.decodeUnknownSync(BrowserTabId)("tab-1");

it("retains localhost ports in Flow download names", () => {
  expect(flowDownloadName("http://localhost:3000/login", "Login")).toBe(
    "localhost-3000-login.json"
  );
});

it("falls back when a download name cannot be normalized", () => {
  expect(flowDownloadName("https://example.com", "🧪")).toBe(
    "contingency-flow.json"
  );
});

const makeCapture = () => {
  let emit: Parameters<RecorderCapture["start"]>[0]["onEvent"] | undefined;
  let stopCount = 0;
  const capture: RecorderCapture = {
    start: (options) =>
      Effect.sync(() => {
        emit = options.onEvent;
        return Effect.sync(() => {
          stopCount += 1;
        });
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
    stopCount: () => stopCount,
  };
};

it.effect("finishes captured browser actions as a validated Flow", () => {
  const capture = makeCapture();

  return Effect.gen(function* recordFlow() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://www.1mg.com/pharmacy",
      sessionId,
      tabId,
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
    expect(finished.flow.selectorAttribute).toBe("data-testid");
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

it.effect("keeps the localhost port in a Flow download name", () => {
  const capture = makeCapture();

  return Effect.gen(function* nameLocalhostFlow() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "http://localhost:3000/login",
      sessionId,
      tabId,
      title: "Login",
    });
    yield* capture.emit({
      offsetX: 1,
      offsetY: 1,
      selectors: ["aria/Submit"],
      type: "click",
    });

    const finished = yield* recording.finish();

    expect(finished.downloadName).toBe("localhost-3000-login.json");
  });
});

it.effect("falls back when a Flow download name cannot be normalized", () => {
  const capture = makeCapture();

  return Effect.gen(function* fallbackDownloadName() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
      title: "!!!",
    });
    yield* capture.emit({
      offsetX: 1,
      offsetY: 1,
      selectors: ["aria/Continue"],
      type: "click",
    });

    const finished = yield* recording.finish();

    expect(finished.downloadName).toBe("contingency-flow.json");
  });
});

it.effect("discards a finished Flow without closing its capture twice", () => {
  const capture = makeCapture();

  return Effect.gen(function* discardFinishedFlow() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
      title: "Finished Flow",
    });
    yield* capture.emit({
      offsetX: 4,
      offsetY: 5,
      selectors: ["aria/Continue"],
      type: "click",
    });

    yield* recording.finish();
    expect(capture.stopCount()).toBe(1);

    yield* recording.discard();

    expect(capture.stopCount()).toBe(1);
    expect(yield* recording.get()).toBeNull();
  });
});

it.effect("rejects finishing when the only authored Step is an Audit", () => {
  const capture = makeCapture();

  return Effect.gen(function* rejectAuditOnlyFlow() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
      title: "Audit only",
    });
    yield* recording.addAudit("accessibility");

    const error = yield* Effect.flip(recording.finish());

    expect(error.code).toBe("recording_invalid");
    expect(error.message).toContain("authored browser Step");
  });
});

it.effect("keeps a redirect chain asserted on its triggering action", () => {
  const capture = makeCapture();

  return Effect.gen(function* recordRedirectChain() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
      title: "Redirect chain",
    });
    yield* capture.emit({
      offsetX: 4,
      offsetY: 5,
      selectors: ["aria/Sign in"],
      type: "click",
    });
    yield* capture.emit({ type: "beforeUnload" });
    yield* capture.emit({
      title: "Redirecting",
      type: "navigation",
      url: "https://auth.example.com/start",
    });
    yield* capture.emit({
      title: "Signed in",
      type: "navigation",
      url: "https://example.com/account",
    });

    const current = yield* recording.get();

    expect(current?.recordedSteps).toHaveLength(2);
    expect(current?.recordedSteps[1]?.step).toMatchObject({
      assertedEvents: [
        {
          title: "Redirecting",
          type: "navigation",
          url: "https://auth.example.com/start",
        },
        {
          title: "Signed in",
          type: "navigation",
          url: "https://example.com/account",
        },
      ],
      type: "click",
    });

    const afterDirectNavigation = yield* recording.recordNavigation(
      "https://example.com/settings"
    );
    expect(afterDirectNavigation.recordedSteps).toHaveLength(3);
    expect(afterDirectNavigation.recordedSteps[2]?.step).toEqual({
      type: "navigate",
      url: "https://example.com/settings",
    });
  });
});

it.effect("pauses capture and resumes into the pinned Recording", () => {
  const capture = makeCapture();

  return Effect.gen(function* pauseAndResume() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
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
      tabId,
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
      tabId,
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

    const error = yield* Effect.flip(
      recording.recover("https://example.com/other")
    );
    const stillIncomplete = yield* recording.get();

    expect(error.code).toBe("recording_invalid");
    expect(error.message).toContain("capture integrity");
    expect(stillIncomplete?.phase).toBe("incomplete");
  });
});

it.effect("preserves the first failure reason during recorder cleanup", () => {
  const capture = makeCapture();

  return Effect.gen(function* preserveFailureReason() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
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
      tabId,
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

it.effect("does not recover a Recording that opened another tab", () => {
  const capture = makeCapture();

  return Effect.gen(function* rejectPopupRecovery() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
      title: "Popup",
    });
    yield* capture.emit({
      offsetX: 2,
      offsetY: 3,
      selectors: ["aria/Open"],
      type: "click",
    });
    yield* recording.fail(
      "The Recording opened or activated an unsupported additional tab."
    );

    const error = yield* Effect.flip(
      recording.recover("https://example.com/popup")
    );
    const incomplete = yield* recording.get();

    expect(error.code).toBe("recording_invalid");
    expect(error.message).toContain("capture integrity");
    expect(incomplete?.phase).toBe("incomplete");
    expect(incomplete?.recordedSteps).toHaveLength(2);
  });
});

it.effect("authors conditional Pre-steps and ordered Audit Steps", () => {
  const capture = makeCapture();

  return Effect.gen(function* authorStepExtensions() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com",
      sessionId,
      tabId,
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
      tabId,
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
      tabId,
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

it.effect("retains sensitive changes using a Variable only", () => {
  const capture = makeCapture();

  return Effect.gen(function* protectSensitiveInput() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId,
      title: "Sign in",
    });
    yield* capture.emit({
      selectors: ["input[type=password]"],
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    const finished = yield* recording.finish();
    const serialized = JSON.stringify(finished.flow);

    expect(serialized).toContain("{{PASSWORD}}");
    expect(finished.flow.contingency?.variables).toEqual([
      { name: "PASSWORD", runtime: true, secret: true },
    ]);
    expect(serialized).not.toContain("hunter2");
  });
});

it.effect("coalesces changes and resolves Variable collisions", () => {
  const capture = makeCapture();

  return Effect.gen(function* coalesceChanges() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId,
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
      selectors: ["#new-password"],
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    yield* capture.emit({
      selectors: ["#confirm-password"],
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    const active = yield* recording.get();

    expect(active?.recordedSteps).toHaveLength(4);
    expect(active?.recordedSteps[1]?.step).toMatchObject({ value: "final" });
    expect(active?.flow.contingency?.variables).toEqual([
      { name: "PASSWORD", runtime: true, secret: true },
      { name: "PASSWORD_2", runtime: true, secret: true },
    ]);
  });
});

it.effect("marks, renames, and reuses Variables", () => {
  const capture = makeCapture();

  return Effect.gen(function* authorVariables() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/profile",
      sessionId,
      tabId,
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

    yield* recording.bindVariable(firstId, "pin");
    yield* recording.renameVariable("PIN", "ACCOUNT_PIN");
    const rebound = yield* recording.bindVariable(secondId, "ACCOUNT_PIN");

    expect(rebound.flow.contingency?.variables).toEqual([
      { name: "ACCOUNT_PIN", runtime: true, secret: true },
    ]);
    expect(rebound.recordedSteps.slice(1).map(({ step }) => step)).toEqual([
      expect.objectContaining({ value: "{{ACCOUNT_PIN}}" }),
      expect.objectContaining({ value: "{{ACCOUNT_PIN}}" }),
    ]);
  });
});

it.effect("declares and renames Variables used by Pre-steps", () => {
  const capture = makeCapture();

  return Effect.gen(function* protectPreStep() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({
      initialUrl: "https://example.com/sign-in",
      sessionId,
      tabId,
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
      selectors: ["#password"],
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    const renamed = yield* recording.renameVariable(
      "PASSWORD",
      "LOGIN_PASSWORD"
    );

    expect(renamed.flow.contingency?.variables).toEqual([
      { name: "LOGIN_PASSWORD", runtime: true, secret: true },
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
      tabId,
      title: "Sign in",
    });
    yield* capture.emit({
      selectors: ["input[type=password]"],
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    const active = yield* recording.get();
    const stepId = active?.recordedSteps[1]?.id;
    if (stepId === undefined) {
      return yield* Effect.die(new Error("Expected a sensitive Step"));
    }

    const deleted = yield* recording.deleteStep(stepId);
    expect(deleted.flow.contingency?.variables).toBeUndefined();
    expect(deleted.undoAvailable).toBe(true);

    const restored = yield* recording.undoDelete();
    expect(restored.recordedSteps[1]?.id).toBe(stepId);
    expect(restored.flow.contingency?.variables).toEqual([
      { name: "PASSWORD", runtime: true, secret: true },
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
      tabId,
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
        tabId,
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
