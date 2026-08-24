import type { AuthoredStep, RecordingSnapshot } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Page } from "playwright-core";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { Recording } from "../../src/services/recording.ts";
import { fixtureServer } from "./harness.ts";

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
    yield* browser.open(sessionId, url, viewport, "chrome-windows");
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

it.live("captures a scroll once, at the position the page came to rest", () =>
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
    expect(scrolls[0]).toMatchObject({ type: "scroll" });

    // A container scrolls where the document does not, and that is the case
    // lazy-loaded content lives in.
    yield* Effect.promise(() => page.hover("#panel"));
    yield* Effect.promise(() => page.mouse.wheel(0, 200));
    yield* Effect.sleep(SCROLL_REST);
    expect(
      (yield* stepsOf(recording)).filter((step) => step.type === "scroll")
    ).toHaveLength(2);
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

it.live("ends the Recording when the page itself calls the binding", () =>
  Effect.gen(function* refuseForgedRecorderData() {
    const fixtures = yield* fixtureServer;
    const { page, recording } = yield* openRecording(
      fixtures.url("recorder.html")
    );

    // The binding a page can find and call is the threat the untrusted
    // boundary exists for: whatever it says must not become a Step, and
    // saying it at all is lost integrity.
    yield* Effect.promise(() =>
      page.evaluate(() => {
        const name = Object.keys(globalThis).find((key) =>
          key.startsWith("__contingency_")
        );
        (globalThis as unknown as Record<string, (raw: string) => void>)[
          name ?? ""
        ]?.("not recorder data at all");
      })
    );
    yield* waitUntil(
      () => Effect.runSync(recording.get())?.phase === "incomplete"
    );

    const snapshot = yield* recording.get();
    expect(snapshot?.incompleteReason).toBe(
      "The page sent malformed recorder data."
    );
    // Lost integrity, so recovery must refuse it.
    const error = yield* Effect.flip(recording.recover());
    expect(error.message).toBe(
      "This Recording cannot be recovered because capture integrity was lost."
    );
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
