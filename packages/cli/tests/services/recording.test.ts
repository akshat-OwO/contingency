import { BrowserTabId, SessionId } from "@contingency/protocol";
import type { AuthoredStep, RecordingSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { RecorderCaptureEvent } from "../../src/services/recorder-events.ts";
import {
  flowDownloadName,
  makeRecordingService,
} from "../../src/services/recording.ts";
import type {
  RecorderCapture,
  RecorderCaptureStartOptions,
} from "../../src/services/recording.ts";

const sessionId = Schema.decodeUnknownSync(SessionId)("create-recording-test");
const tabId = Schema.decodeUnknownSync(BrowserTabId)("tab-1");
const INITIAL_URL = "https://shop.example.com/cart";

const cartButton = [
  { kind: "role", name: "Add to cart", role: "button" },
  { kind: "css", selector: "button#cart" },
] as const;
const emailField = [
  { kind: "label", label: "Email" },
  { kind: "css", selector: "input#email" },
] as const;

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

/**
 * Capture, faked at the seam the Playwright recorder implements. What a page
 * reported is the input to every assertion here; how it reached the CLI is the
 * integration suite's subject, not this one's.
 */
const makeCapture = (url = INITIAL_URL) => {
  let options: RecorderCaptureStartOptions | undefined;
  let stopCount = 0;
  let startCount = 0;
  const capture: RecorderCapture = {
    start: (started) =>
      Effect.sync(() => {
        options = started;
        startCount += 1;
        return {
          stop: Effect.sync(() => {
            stopCount += 1;
          }),
          tabId,
          url,
        };
      }),
  };

  const started = () => {
    if (options === undefined) {
      throw new Error("Capture has not started");
    }
    return options;
  };

  return {
    capture,
    emit: (event: RecorderCaptureEvent) => started().onEvent(event),
    fail: (message: string) => started().onFailure(message),
    sessionId: () => started().sessionId,
    startCount: () => startCount,
    stopCount: () => stopCount,
  };
};

const steps = (snapshot: RecordingSnapshot): readonly AuthoredStep[] =>
  snapshot.flow.steps;

const startRecording = (capture: ReturnType<typeof makeCapture>) =>
  Effect.gen(function* start() {
    const recording = yield* makeRecordingService(capture.capture);
    yield* recording.start({ sessionId, title: "Checkout" });
    return recording;
  });

it.effect("records the Page a Step acted on, and only past the first", () =>
  Effect.gen(function* recordPages() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({
      button: "left",
      page: 1,
      target: cartButton,
      type: "click",
    });
    const snapshot = yield* recording.get();
    const recorded = steps(snapshot as RecordingSnapshot);
    expect(recorded[1]).toMatchObject({ type: "click" });
    expect(recorded[1]).not.toHaveProperty("page");
    expect(recorded[2]).toMatchObject({ page: 1, type: "click" });
  })
);

it.effect("keeps recording when a popup opens as a further Page", () =>
  Effect.gen(function* followPopup() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({
      causedByAction: false,
      page: 1,
      title: "Checkout",
      type: "navigation",
      url: "https://checkout.example.com/",
    });
    yield* capture.emit({
      button: "left",
      page: 1,
      target: cartButton,
      type: "click",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.phase).toBe("active");
    expect(steps(snapshot).at(-1)).toMatchObject({ page: 1, type: "click" });
  })
);

it.effect("captures hover only when the author has armed it", () =>
  Effect.gen(function* captureHover() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    expect(
      steps((yield* recording.get()) as RecordingSnapshot).at(-1)
    ).toMatchObject({ type: "click" });

    yield* recording.armHover();
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.captureMode).toBe("ordinary");
    expect(steps(snapshot).at(-1)).toMatchObject({
      target: cartButton,
      type: "hover",
    });
  })
);

it.effect("records a scroll as one Step per resting position", () =>
  Effect.gen(function* captureScroll() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({ deltaY: 900, page: 0, type: "scroll" });
    yield* capture.emit({ deltaY: 400, page: 0, type: "scroll" });
    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded.slice(1)).toEqual([
      { deltaY: 900, id: expect.any(String), type: "scroll" },
      { deltaY: 400, id: expect.any(String), type: "scroll" },
    ]);
  })
);

it.effect("records a locator ladder led by role, never a test id", () =>
  Effect.gen(function* recordLadder() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    const [step] = steps(snapshot).slice(1);
    expect(step).toMatchObject({ target: cartButton });
    expect(JSON.stringify(snapshot.flow)).not.toContain("testId");
  })
);

it.effect("names a Variable for a sensitive field rather than storing it", () =>
  Effect.gen(function* recordSecret() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      page: 0,
      target: emailField,
      type: "change",
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(steps(snapshot).at(-1)).toMatchObject({
      value: "{{PASSWORD}}",
      variable: "PASSWORD",
    });
    expect(snapshot.flow.variables).toEqual([
      { name: "PASSWORD", runtime: true, secret: true },
    ]);
  })
);

it.effect("replaces the Step before it when a field is edited again", () =>
  Effect.gen(function* replaceChange() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      page: 0,
      target: emailField,
      type: "change",
      value: "a@b.c",
    });
    yield* capture.emit({
      page: 0,
      target: emailField,
      type: "change",
      value: "author@example.com",
    });
    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded).toHaveLength(2);
    expect(recorded.at(-1)).toMatchObject({ value: "author@example.com" });
  })
);

it.effect("drops a navigation an action caused, and keeps one it did not", () =>
  Effect.gen(function* reduceNavigations() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({
      causedByAction: true,
      page: 0,
      type: "navigation",
      url: "https://shop.example.com/checkout",
    });
    yield* capture.emit({
      causedByAction: false,
      page: 0,
      type: "navigation",
      url: "https://shop.example.com/receipt",
    });
    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded.map((step) => step.type)).toEqual([
      "navigate",
      "click",
      "navigate",
    ]);
    expect(recorded.at(-1)).toMatchObject({
      url: "https://shop.example.com/receipt",
    });
  })
);

it.effect("ends the Recording when the pinned tab navigates while paused", () =>
  Effect.gen(function* navigateWhilePaused() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.pause();
    yield* capture.emit({
      causedByAction: false,
      page: 0,
      type: "navigation",
      url: "https://shop.example.com/elsewhere",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.phase).toBe("incomplete");
    expect(snapshot.incompleteReason).toBe(
      "The pinned tab navigated while capture was paused."
    );
    expect(capture.stopCount()).toBe(1);
  })
);

it.effect("ends the Recording when an element cannot be addressed", () =>
  Effect.gen(function* unaddressableElement() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      page: 0,
      reason: "An element on the page could not be addressed by any locator.",
      type: "unsupported",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.phase).toBe("incomplete");
    expect(snapshot.incompleteReason).toBe(
      "An element on the page could not be addressed by any locator."
    );
  })
);

it.effect("recovers a Recording whose recorder connection was lost", () =>
  Effect.gen(function* recoverRecording() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.fail("The browser recorder connection was lost.");
    expect(((yield* recording.get()) as RecordingSnapshot).phase).toBe(
      "incomplete"
    );

    const recovered = yield* recording.recover();
    expect(recovered.phase).toBe("active");
    expect(capture.startCount()).toBe(2);
    expect(capture.sessionId()).toBe(sessionId);
    expect(steps(recovered).at(-1)).toMatchObject({
      type: "navigate",
      url: INITIAL_URL,
    });
  })
);

it.effect("refuses to recover a Recording that lost capture integrity", () =>
  Effect.gen(function* refuseRecovery() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.fail("The page sent malformed recorder data.");
    const error = yield* Effect.flip(recording.recover());
    expect(error.message).toBe(
      "This Recording cannot be recovered because capture integrity was lost."
    );
  })
);

it.effect("finishes a captured Flow that validates against the schema", () =>
  Effect.gen(function* finishRecording() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({ deltaY: 600, page: 0, type: "scroll" });
    yield* recording.armHover();
    yield* capture.emit({
      button: "left",
      page: 1,
      target: cartButton,
      type: "click",
    });
    yield* recording.addAudit("accessibility");
    const finished = yield* recording.finish();
    expect(finished.phase).toBe("finished");
    expect(capture.stopCount()).toBe(1);
    expect(finished.flow.steps.map((step) => step.type)).toEqual([
      "navigate",
      "click",
      "scroll",
      "hover",
      "audit",
    ]);
    expect(finished.downloadName).toBe("shop-example-com-checkout.json");
  })
);

it.effect("records a selectOption and a press as their own Step kinds", () =>
  Effect.gen(function* recordSelectAndPress() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* capture.emit({
      page: 0,
      target: emailField,
      type: "selectOption",
      values: ["blue"],
    });
    yield* capture.emit({ key: "Enter", page: 0, type: "press" });
    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded.map((step) => step.type)).toEqual([
      "navigate",
      "selectOption",
      "press",
    ]);
    expect(recorded[1]).toMatchObject({ values: ["blue"] });
    expect(recorded[2]).toMatchObject({ key: "Enter" });
  })
);

it.effect("authors a Pre-step and its condition from captured actions", () =>
  Effect.gen(function* authorPreStep() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.armPreStep({ type: "flow" });
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.captureMode).toBe("ordinary");
    expect(snapshot.flow.preSteps).toEqual([
      {
        id: expect.any(String),
        step: { button: "left", target: cartButton, type: "click" },
        when: { target: cartButton, type: "selectorVisible" },
      },
    ]);
  })
);
