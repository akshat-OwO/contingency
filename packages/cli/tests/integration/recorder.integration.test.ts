import type { AuthoredStep, RecordingSnapshot } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Page } from "playwright-core";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { connectionLost } from "../../src/services/recorder-events.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { Recording } from "../../src/services/recording.ts";
import {
  DOCUMENT_SCROLL_BEACON,
  draftEmulation,
  fixtureServer,
  IntegrationLive,
  NESTED_SCROLL_BEACON,
  runFlow,
} from "./harness.ts";

/**
 * The Recorder, driving a real Chromium in process.
 *
 * Nothing here is faked. Every claim in this file is one a fake page cannot
 * falsify: whether an init script actually reaches a cross-origin frame,
 * whether Playwright's own input is trusted enough to be captured, whether a
 * popup arrives as a further Page, and whether the ladder the page computes
 * resolves against real DOM.
 */
const RecorderIntegrationLive = RecordingLive.pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);

const RecorderReplayIntegrationLive = Layer.merge(
  RecorderIntegrationLive,
  IntegrationLive
);

type PageCallable = (credential?: string, payload?: string) => void;
type JsonReceiver = NonNullable<object>;

declare global {
  var __contingencyRecorderCleanup: PageCallable | undefined;
  var __contingencyRecorderSetSwallowClicks: PageCallable | undefined;
  var __seen: string[];
  var __trap: {
    readonly credentials: string[];
    readonly retained: PageCallable[];
  };
}

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 } as const;

/** How long the page must sit still before the recorder settles a scroll. */
const SCROLL_REST = "600 millis";

const waitUntil = (ready: () => boolean) =>
  Effect.gen(function* waitForCondition() {
    while (!ready()) {
      yield* Effect.sleep("20 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));

const clickPopup = (page: Page) =>
  Effect.promise(() => page.click("#open-popup"));

const openRecording = (url: string, title = "Recorder") =>
  Effect.gen(function* openAndRecord() {
    const browser = yield* CreateBrowser;
    const recording = yield* Recording;
    const sessionId = yield* browser.create(
      `create-recorder-${Date.now()}`,
      viewport
    );
    yield* Effect.addFinalizer(() =>
      browser.close(sessionId).pipe(Effect.ignore)
    );
    yield* browser.open(
      sessionId,
      url,
      draftEmulation("chrome-windows", viewport)
    );
    yield* recording.start({ sessionId, title });
    const target = yield* browser.recorderTarget(sessionId);
    return { browser, page: target.page, recording, sessionId };
  });

const snapshotSteps = (
  snapshot: RecordingSnapshot | null
): readonly AuthoredStep[] => snapshot?.flow.steps ?? [];

const stepsOf = (recording: {
  readonly get: () => Effect.Effect<RecordingSnapshot | null>;
}) => recording.get().pipe(Effect.map(snapshotSteps));

it.live("captures a click through a ladder led by role, never a test id", () =>
  Effect.gen(function* captureClick() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    yield* Effect.promise(() => page.click("#cart"));
    yield* waitUntil(() => true);
    yield* Effect.sleep("200 millis");

    const steps = yield* stepsOf(recording);
    const click = steps.at(-1);
    expect(click).toMatchObject({ type: "click" });
    const target =
      click !== undefined && "target" in click ? click.target : undefined;
    expect(target?.[0]).toEqual({
      kind: "role",
      name: "Add to cart",
      role: "button",
    });
    const snapshot = yield* recording.get();
    expect(JSON.stringify(snapshot)).not.toContain("data-testid");
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live(
  "captures a change and a withheld secret, ignoring untrusted edits",
  () =>
    Effect.gen(function* captureFormEdits() {
      const fixtures = yield* fixtureServer;
      const { page, recording } = yield* openRecording(
        fixtures.url("recorder.html")
      );

      yield* Effect.promise(() =>
        page.fill('input[name="email"]', "author@example.com")
      );
      // `selectOption` sets the value from script, so the change it dispatches
      // is untrusted: the site behaving, not the author acting. It must leave
      // no Step behind.
      yield* Effect.promise(() =>
        page.selectOption('select[name="colour"]', "blue")
      );
      yield* Effect.promise(() =>
        page.fill('input[name="password"]', "hunter2")
      );
      yield* Effect.sleep("300 millis");

      const steps = yield* stepsOf(recording);
      const kinds = steps.map((step) => step.type);
      expect(kinds).toContain("change");
      expect(kinds).not.toContain("selectOption");
      const secret = steps.findLast((step) => step.type === "change");
      expect(secret).toMatchObject({ value: "{{PASSWORD}}" });
      expect(JSON.stringify(yield* recording.get())).not.toContain("hunter2");
    }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live(
  "records a trusted dropdown selection and key press as single Steps",
  () =>
    Effect.gen(function* captureSelectAndPress() {
      const fixtures = yield* fixtureServer;
      const { page, recording } = yield* openRecording(
        fixtures.url("recorder.html")
      );

      // Keyboard input goes through the browser's user-input path, so the
      // resulting change event is trusted. A page-authored `selectOption` call
      // remains ignored by the test above.
      yield* Effect.promise(() => page.focus('select[name="colour"]'));
      yield* Effect.promise(() => page.keyboard.press("r"));
      yield* Effect.promise(() => page.keyboard.press("Tab"));
      yield* Effect.sleep("200 millis");

      expect(
        yield* Effect.promise(() => page.inputValue('select[name="colour"]'))
      ).toBe("red");
      const steps = yield* stepsOf(recording);
      expect(steps.filter((step) => step.type === "selectOption")).toEqual([
        expect.objectContaining({ type: "selectOption", values: ["red"] }),
      ]);
      expect(
        steps.some((step) => step.type === "press" && step.key === "Tab")
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("captures a document scroll once at its resting position", () =>
  Effect.gen(function* captureScroll() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    yield* Effect.promise(() => page.mouse.wheel(0, 300));
    yield* Effect.promise(() => page.mouse.wheel(0, 300));
    yield* Effect.sleep(SCROLL_REST);

    const scrolls = (yield* stepsOf(recording)).filter(
      (step) => step.type === "scroll"
    );
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]).toMatchObject({ deltaY: 600, type: "scroll" });
    expect(scrolls[0]).not.toHaveProperty("target");
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("records and replays document and nested-container Scrolls", () =>
  Effect.gen(function* recordAndReplayScrolls() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("nested-scroll.html")
    );

    yield* Effect.promise(() => page.hover("#panel"));
    yield* Effect.promise(() => page.mouse.wheel(0, 200));
    yield* Effect.sleep(SCROLL_REST);
    yield* Effect.promise(() => page.mouse.move(500, 300));
    yield* Effect.promise(() => page.mouse.wheel(0, 300));
    yield* Effect.sleep(SCROLL_REST);

    const snapshot = yield* recording.get();
    const scrolls = snapshotSteps(snapshot).filter(
      (step) => step.type === "scroll"
    );
    expect(scrolls).toHaveLength(2);
    expect(scrolls[0]).toMatchObject({ deltaY: 200 });
    expect(scrolls[0]).toHaveProperty("target");
    expect(scrolls[1]).toMatchObject({ deltaY: 300 });
    expect(scrolls[1]).not.toHaveProperty("target");

    if (snapshot === null) {
      return;
    }
    const { run } = yield* runFlow(snapshot.flow);
    expect(run.outcome).toBe("completed");
    expect(fixtures.requests).toContain(NESTED_SCROLL_BEACON);
    expect(fixtures.requests).toContain(DOCUMENT_SCROLL_BEACON);
  }).pipe(Effect.scoped, Effect.provide(RecorderReplayIntegrationLive))
);

it.live("does not record a wheel gesture that cannot move its container", () =>
  Effect.gen(function* ignoreWheelAtBoundary() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("nested-scroll.html?panel-at-end")
    );

    yield* Effect.promise(() => page.hover("#panel"));
    yield* Effect.promise(() => page.mouse.wheel(0, 200));
    yield* Effect.sleep(SCROLL_REST);

    expect(
      (yield* stepsOf(recording)).filter((step) => step.type === "scroll")
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("captures hover only through the author's explicit control", () =>
  Effect.gen(function* captureHover() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    // Ordinary mouse movement is an inspection signal, never a Step.
    yield* Effect.promise(() => page.hover("#cart"));
    yield* Effect.sleep("300 millis");
    expect(
      (yield* stepsOf(recording)).some((step) => step.type === "hover")
    ).toBe(false);

    yield* recording.armHover();
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");

    const hover = (yield* stepsOf(recording)).at(-1);
    expect(hover).toMatchObject({ type: "hover" });
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("swallows the picker click while hover capture is armed", () =>
  Effect.gen(function* swallowHoverPickerClick() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    yield* Effect.promise(() =>
      page.evaluate(`(() => {
        globalThis.__cartClicked = false;
        document.getElementById("cart")?.addEventListener(
          "click",
          () => {
            globalThis.__cartClicked = true;
          },
          { once: true }
        );
      })()`)
    );

    yield* recording.armHover();
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");

    const clickReachedPage = yield* Effect.promise(() =>
      page.evaluate("globalThis.__cartClicked === true")
    );
    expect(clickReachedPage).toBe(false);

    const hover = (yield* stepsOf(recording)).at(-1);
    expect(hover).toMatchObject({ type: "hover" });

    yield* Effect.promise(() =>
      page.evaluate(`(() => {
        globalThis.__cartClicked = false;
        document.getElementById("cart")?.addEventListener(
          "click",
          () => {
            globalThis.__cartClicked = true;
          },
          { once: true }
        );
      })()`)
    );
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");

    const clickRecordedAfterPicker = yield* Effect.promise(() =>
      page.evaluate("globalThis.__cartClicked === true")
    );
    expect(clickRecordedAfterPicker).toBe(true);
    expect((yield* stepsOf(recording)).at(-1)).toMatchObject({ type: "click" });
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("records a popup as a further Page, and names it on its Steps", () =>
  Effect.gen(function* followPopup() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("popup.html")
    );

    // The Page event is awaited from before the click, so the popup cannot
    // open in the gap between acting and starting to watch.
    const opened = Effect.promise((): Promise<Page> =>
      page.context().waitForEvent("page")
    );
    const popup = yield* Effect.all([opened, clickPopup(page)], {
      concurrency: 2,
    }).pipe(Effect.map(([page_]) => page_));
    yield* Effect.promise(() => popup.waitForLoadState("domcontentloaded"));
    yield* Effect.promise(() => popup.click("#popup-title"));
    yield* Effect.sleep("300 millis");

    const snapshot = yield* recording.get();
    expect(snapshot?.phase).toBe("active");
    const captured = snapshotSteps(snapshot).at(-1);
    expect(captured).toMatchObject({ page: 1 });
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("captures inside a cross-origin frame and an open shadow root", () =>
  Effect.gen(function* captureFramesAndShadow() {
    const fixtures = yield* fixtureServer;
    // The same server, addressed by a different host: the frame the fixture
    // loads is genuinely cross-origin, which only an init script reaches.
    const framed = fixtures.url("frame.html").replace("127.0.0.1", "localhost");
    const { page, recording } = yield* openRecording(
      `${fixtures.url("recorder.html")}?frame=${encodeURIComponent(framed)}`
    );

    yield* Effect.promise(() =>
      page.waitForSelector("#framed", { state: "attached" })
    );
    yield* Effect.promise(() =>
      page.frameLocator("#framed").locator("#framed").click()
    );
    yield* Effect.promise(() =>
      page.locator("#open-host").locator("#shadow-button").click()
    );
    yield* Effect.sleep("300 millis");

    const clicks = (yield* stepsOf(recording)).filter(
      (step) => step.type === "click"
    );
    const targets = clicks.flatMap((step) =>
      "target" in step ? [JSON.stringify(step.target)] : []
    );
    expect(targets.some((target) => target.includes("Subscribe"))).toBe(true);
    expect(targets.some((target) => target.includes("Open menu"))).toBe(true);
    const snapshot = yield* recording.get();
    expect(snapshot?.phase).toBe("active");
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("ends the Recording when the pinned session closes", () =>
  Effect.gen(function* closePinnedSession() {
    const fixtures = yield* fixtureServer;
    const { browser, recording, sessionId } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    yield* browser.close(sessionId);
    yield* waitUntil(
      () => Effect.runSync(recording.get())?.phase === "incomplete"
    );

    const snapshot = yield* recording.get();
    expect(snapshot?.phase).toBe("incomplete");
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("finishes a captured Flow that validates against the schema", () =>
  Effect.gen(function* finishRecording() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html"),
      "Cart"
    );

    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("200 millis");
    const finished = yield* recording.finish();

    expect(finished.phase).toBe("finished");
    expect(finished.flow.steps[0]).toMatchObject({ type: "navigate" });
    expect(finished.downloadName?.endsWith("-cart.json")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("cannot be made to record a Step by page code", () =>
  Effect.gen(function* refuseForgedRecorderData() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    // Hook the page's own serializer before any real action, then act, so the
    // page sees everything a legitimate emission passes through. This is the
    // attack: intercept one real report, learn the credential, replay it.
    yield* Effect.promise(() =>
      page.evaluate(() => {
        const seen: string[] = [];
        globalThis.__seen = seen;
        const original = JSON.stringify;
        // oxlint-disable-next-line eslint/no-extend-native
        JSON.stringify = (value) => {
          const output = original(value);
          seen.push(String(output));
          return output;
        };
        // Records the shape it is handed rather than re-serializing it,
        // which would recurse back through the hook above. Extending the
        // native prototype is the attack under test, not a style slip.
        // oxlint-disable-next-line eslint/no-extend-native
        Object.defineProperty(Object.prototype, "toJSON", {
          configurable: true,
          value(this: JsonReceiver) {
            seen.push(`toJSON:${Object.keys(this).join("|")}`);
            return this;
          },
          writable: true,
        });
      })
    );
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");
    const before = (yield* stepsOf(recording)).length;

    const attack = yield* Effect.promise(() =>
      page.evaluate(() => {
        // Every global the page can see, not a guessed prefix: whatever the
        // recorder retained must not be callable from here.
        const globals = Object.keys(globalThis).filter((key) =>
          key.toLowerCase().includes("contingency")
        );
        const callable = globals.filter(
          (key) =>
            Object.prototype.toString.call(
              Object.getOwnPropertyDescriptor(globalThis, key)?.value
            ) === "[object Function]"
        );
        const forged = JSON.stringify({
          documentId: "forged-document",
          event: {
            button: "left",
            target: [{ kind: "role", name: "Pay now", role: "button" }],
            type: "click",
          },
          sequence: 1,
        });
        const observed = globalThis.__seen;
        // Try the credential every way the page could have learned it.
        for (const credential of [undefined, "guessed", ...observed]) {
          try {
            globalThis.__contingencyRecorderSetSwallowClicks?.(
              credential,
              forged
            );
            globalThis.__contingencyRecorderSetSwallowClicks?.(forged);
            globalThis.__contingencyRecorderCleanup?.(credential, forged);
            globalThis.__contingencyRecorderCleanup?.(forged);
          } catch {
            // A throw is fine; being ignored is the point.
          }
        }
        return { callable, globals, observed };
      })
    );
    yield* Effect.sleep("300 millis");

    // The transport is not among the page's globals at all. Cleanup and
    // hover-picker swallow toggling are, by necessity — the CLI evaluates
    // them in the main world — and are guarded by the same credential
    // instead, which the next test exercises.
    expect(attack.callable).toEqual([
      "__contingencyRecorderSetSwallowClicks",
      "__contingencyRecorderCleanup",
    ]);
    // The page did observe the recorder's real emission for its own click —
    // that data is the page's own — but no credential passed through the
    // serializer, so replaying what it saw authorizes nothing.
    expect(attack.observed.length).toBeGreaterThan(0);
    for (const observed of attack.observed) {
      expect(observed).not.toContain("nonce");
    }
    const snapshot = yield* recording.get();
    // Ignored, not fatal: a site must not be able to destroy an author's
    // Recording by calling a function it discovered.
    expect(snapshot?.phase).toBe("active");
    expect(snapshotSteps(snapshot)).toHaveLength(before);
    expect(JSON.stringify(snapshot)).not.toContain("Pay now");

    // And the author's own actions still record, so the boundary did not
    // simply switch capture off.
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");
    expect((yield* stepsOf(recording)).length).toBe(before + 1);
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("keeps capture running when page code calls cleanup", () =>
  Effect.gen(function* refuseForgedCleanup() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );
    const before = (yield* stepsOf(recording)).length;

    // Stopping the recorder is the recorder's to do. A page that could call
    // cleanup would silently omit every action after it.
    yield* Effect.promise(() =>
      page.evaluate(() => {
        const cleanup = globalThis.__contingencyRecorderCleanup;
        cleanup?.();
        cleanup?.("guessed");
      })
    );
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");

    expect((yield* stepsOf(recording)).length).toBe(before + 1);
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

it.live("records the host of a closed shadow root, never through it", () =>
  Effect.gen(function* closedShadowRoot() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    // A closed root cannot be reached by a locator either, so the click
    // lands on the host — exactly what a real author's pointer does.
    yield* Effect.promise(() => page.locator("#closed-host").click());
    yield* Effect.sleep("300 millis");

    // A closed root is outside the recording boundary by design: what the
    // page shows the outside world is the host, so that is what is recorded.
    const snapshot = yield* recording.get();
    expect(snapshot?.phase).toBe("active");
    const captured = JSON.stringify(snapshotSteps(snapshot).at(-1));
    expect(captured).toContain("closed-host");
    expect(captured).not.toContain("closed-button");
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);

/**
 * A page lying in wait: it installs its own cleanup callback and watches for
 * the exposed binding to appear, which is what an already-loaded document can
 * do while capture is attaching to it.
 */
const AMBUSH = `(() => {
  const trap = { credentials: [], retained: [] };
  globalThis.__trap = trap;
  globalThis.__contingencyRecorderCleanup = (...args) => {
    trap.credentials.push(...args.map((value) => String(value)));
  };
  const seen = new Set(Object.keys(globalThis));
  const watch = () => {
    for (const key of Object.keys(globalThis)) {
      if (!seen.has(key) && key.startsWith("__contingency_")) {
        seen.add(key);
        trap.retained.push(globalThis[key]);
      }
    }
    setTimeout(watch, 1);
  };
  watch();
})();`;

it.live("reveals nothing to a page waiting for capture to attach", () =>
  Effect.gen(function* ambushAttachment() {
    const fixtures = yield* fixtureServer;
    const browser = yield* CreateBrowser;
    const recording = yield* Recording;
    const sessionId = yield* browser.create(
      `create-ambush-${Date.now()}`,
      viewport
    );
    yield* Effect.addFinalizer(() =>
      browser.close(sessionId).pipe(Effect.ignore)
    );
    yield* browser.open(
      sessionId,
      fixtures.url("recorder.html"),
      draftEmulation("chrome-windows", viewport)
    );

    // The ambush is in place before capture starts, in the document capture
    // will attach to.
    const attaching = yield* browser.recorderTarget(sessionId);
    yield* Effect.promise(() => attaching.page.evaluate(AMBUSH));
    yield* recording.start({ sessionId, title: "Ambush" });
    const { page } = yield* browser.recorderTarget(sessionId);
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");
    const before = (yield* stepsOf(recording)).length;

    const forge = () =>
      Effect.promise(() =>
        page.evaluate(() => {
          const trap = globalThis.__trap;
          const forged = JSON.stringify({
            documentId: `forged-${Math.random()}`,
            event: {
              button: "left",
              target: [{ kind: "role", name: "Pay now", role: "button" }],
              type: "click",
            },
            sequence: 1,
          });
          for (const binding of trap.retained) {
            for (const credential of [undefined, ...trap.credentials]) {
              try {
                binding(credential, forged);
                binding(forged);
              } catch {
                // Being ignored is the point.
              }
            }
          }
          return {
            credentials: trap.credentials,
            retained: trap.retained.length,
          };
        })
      );

    const attached = yield* forge();
    yield* Effect.sleep("300 millis");
    // Retaining the binding is possible in an already-loaded document; being
    // handed the credential is not, so retention authorizes nothing.
    expect(attached.credentials).toEqual([]);
    expect((yield* stepsOf(recording)).length).toBe(before);

    // The same must hold when capture re-attaches to recover a Recording.
    yield* recording.fail(
      connectionLost("The browser recorder connection was lost.")
    );
    yield* recording.recover();
    yield* Effect.sleep("300 millis");
    const recovered = yield* forge();
    yield* Effect.sleep("300 millis");
    expect(recovered.credentials).toEqual([]);

    const snapshot = yield* recording.get();
    expect(snapshot?.phase).toBe("active");
    expect(JSON.stringify(snapshot)).not.toContain("Pay now");

    // Capture still works after both attachments.
    const settled = snapshotSteps(snapshot).length;
    yield* Effect.promise(() => page.click("#cart"));
    yield* Effect.sleep("300 millis");
    expect((yield* stepsOf(recording)).length).toBe(settled + 1);
  }).pipe(Effect.scoped, Effect.provide(RecorderIntegrationLive))
);
