import { BrowserTabId, SessionId } from "@contingency/protocol";
import type { AuthoredStep, RecordingSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  connectionLost,
  integrityLost,
} from "../../src/services/recorder-events.ts";
import type { ReducibleCaptureEvent } from "../../src/services/recorder-events.ts";
import { flowDownloadName } from "../../src/services/recording-flow.ts";
import { makeRecordingService } from "../../src/services/recording.ts";
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
    emit: (event: ReducibleCaptureEvent) => started().onEvent(event),
    fail: (failure: Parameters<RecorderCaptureStartOptions["onFailure"]>[0]) =>
      started().onFailure(failure),
    pinnedTabId: () => started().tabId,
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
      page: 1,
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
    // No action preceded this one, so it is the author navigating.
    yield* capture.emit({
      page: 0,
      type: "navigation",
      url: "https://shop.example.com/receipt",
    });
    // This one follows a click within the window, so the click already
    // implies it: replaying the click navigates by itself.
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({
      page: 0,
      type: "navigation",
      url: "https://shop.example.com/checkout",
    });
    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded.map((step) => step.type)).toEqual([
      "navigate",
      "navigate",
      "click",
    ]);
    expect(recorded[1]).toMatchObject({
      url: "https://shop.example.com/receipt",
    });
  })
);

it.effect("ends the Recording when the pinned tab navigates while paused", () =>
  Effect.gen(function* navigateWhilePaused() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.pause();
    // A background Page refreshing itself is not the author navigating away
    // from what they paused on.
    yield* capture.emit({
      page: 1,
      type: "navigation",
      url: "https://shop.example.com/background",
    });
    expect(((yield* recording.get()) as RecordingSnapshot).phase).toBe(
      "paused"
    );

    yield* capture.emit({
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
    yield* capture.fail(
      integrityLost(
        "An element on the page could not be addressed by any locator."
      )
    );
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
    yield* capture.fail(
      connectionLost("The browser recorder connection was lost.")
    );
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
    yield* capture.fail(
      integrityLost("The page sent malformed recorder data.")
    );
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

it.effect("authors a selectorHidden condition from an armed hidden pick", () =>
  Effect.gen(function* authorHiddenCondition() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.armPreStep({ type: "flow" });
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    // The banner is dismissed by the same action that arms the hidden check:
    // the pick names the element the Flow waits to disappear.
    yield* recording.armPreStepCondition(
      { index: 0, type: "flow" },
      "selectorHidden"
    );
    yield* capture.emit({
      button: "left",
      page: 0,
      target: emailField,
      type: "click",
    });
    const snapshot = (yield* recording.get()) as RecordingSnapshot;
    expect(snapshot.captureMode).toBe("ordinary");
    expect(snapshot.flow.preSteps?.[0]?.when).toEqual({
      target: emailField,
      type: "selectorHidden",
    });
  })
);

it.effect("sets a urlMatches condition on a Pre-step directly", () =>
  Effect.gen(function* setUrlCondition() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.armPreStep({ type: "flow" });
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    // A URL condition has no element to pick, so the author supplies it.
    const updated = yield* recording.setPreStepConditionUrl(
      { index: 0, type: "flow" },
      "/checkout$"
    );
    expect(updated.flow.preSteps?.[0]?.when).toEqual({
      pattern: "/checkout$",
      type: "urlMatches",
    });

    const missing = yield* Effect.result(
      recording.setPreStepConditionUrl({ index: 7, type: "flow" }, "/cart$")
    );
    expect(missing._tag).toBe("Failure");
  })
);

it.effect("ignores an untargeted action while a pick is armed", () =>
  Effect.gen(function* scrollWhilePicking() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    yield* recording.armHover();
    // Scrolling to reach the element you mean to hover is not a pick, and
    // must not end the Recording.
    yield* capture.emit({ deltaY: 400, page: 0, type: "scroll" });
    yield* capture.emit({ key: "Enter", page: 0, type: "press" });
    const armed = (yield* recording.get()) as RecordingSnapshot;
    expect(armed.phase).toBe("active");
    expect(armed.captureMode).toBe("hoverPicker");

    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    const picked = (yield* recording.get()) as RecordingSnapshot;
    expect(picked.captureMode).toBe("ordinary");
    expect(steps(picked).at(-1)).toMatchObject({ type: "hover" });
  })
);

it.effect("re-pins recovery to the Page the Recording already names", () =>
  Effect.gen(function* recoverOnPinnedPage() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    expect(capture.pinnedTabId()).toBeUndefined();

    yield* capture.fail(
      connectionLost("The browser recorder connection was lost.")
    );
    yield* recording.recover();
    // Page 0 stays Page 0: a re-derived index would make Steps recorded
    // before and after recovery name different Pages for the same tab.
    expect(capture.pinnedTabId()).toBe(tabId);
  })
);

it.effect(
  "keeps a sensitive query Variable replayable across later edits",
  () =>
    Effect.gen(function* sensitiveQueryVariable() {
      const capture = makeCapture(
        "https://shop.example.com/cart?token=abc123&size=large"
      );
      const recording = yield* startRecording(capture);
      const started = (yield* recording.get()) as RecordingSnapshot;

      // The placeholder has to survive as a reference the Runner can resolve:
      // percent-encoded braces are text, and replay would send them verbatim.
      expect(started.initialUrl).toContain("{{TOKEN}}");
      expect(started.initialUrl).not.toContain("%7B%7B");
      expect(started.flow.variables).toEqual([
        { name: "TOKEN", runtime: true, secret: true },
      ]);

      // A later navigation carrying its own sensitive parameter, and an edit
      // that re-derives the Flow's Variables, must both keep the declaration.
      yield* capture.emit({
        page: 0,
        type: "navigation",
        url: "https://shop.example.com/pay?secret=xyz789",
      });
      yield* recording.addAudit("accessibility");
      const later = (yield* recording.get()) as RecordingSnapshot;
      const names = (later.flow.variables ?? []).map(({ name }) => name);
      expect(names).toContain("TOKEN");
      expect(names).toContain("SECRET");
      expect(JSON.stringify(later.flow)).not.toContain("%7B%7B");
      expect(JSON.stringify(later.flow)).not.toContain("abc123");
      expect(JSON.stringify(later.flow)).not.toContain("xyz789");
    })
);

it.effect("attributes a navigation to its own Page, not to any Page", () =>
  Effect.gen(function* perPageAttribution() {
    const capture = makeCapture();
    const recording = yield* startRecording(capture);
    // A click on Page 0 explains a navigation on Page 0, and nothing else.
    yield* capture.emit({
      button: "left",
      page: 0,
      target: cartButton,
      type: "click",
    });
    yield* capture.emit({
      page: 1,
      type: "navigation",
      url: "https://shop.example.com/independent",
    });
    // The same holds for beforeUnload, which is a Page leaving, not a session.
    yield* capture.emit({ page: 0, type: "beforeUnload" });
    yield* capture.emit({
      page: 2,
      type: "navigation",
      url: "https://shop.example.com/unrelated",
    });

    const recorded = steps((yield* recording.get()) as RecordingSnapshot);
    expect(recorded.map((step) => step.type)).toEqual([
      "navigate",
      "click",
      "navigate",
      "navigate",
    ]);
    expect(recorded[2]).toMatchObject({
      page: 1,
      url: "https://shop.example.com/independent",
    });
    expect(recorded[3]).toMatchObject({
      page: 2,
      url: "https://shop.example.com/unrelated",
    });
  })
);
