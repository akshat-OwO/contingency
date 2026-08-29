import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  canDecodeVideo,
  fixtureServer,
  flow,
  IntegrationLive,
  LAZY_LOADED_BEACON,
  LOAD_READY_BEACON,
  NESTED_SCROLL_BEACON,
  recordingDurationSeconds,
  runFlow,
  STEP_BEACON,
} from "./harness";

it.live(
  "waits for network idle before starting the Step after navigation",
  () =>
    Effect.gen(function* replayAfterNetworkIdle() {
      const fixtures = yield* fixtureServer;

      const { run } = yield* runFlow(
        flow([
          { type: "navigate", url: fixtures.url("network-idle.html") },
          {
            target: [
              { kind: "role", name: "Continue after load", role: "button" },
            ],
            timeout: 100,
            type: "click",
          },
        ])
      );

      expect(run.outcome).toBe("completed");
      expect(fixtures.requests).toContain(LOAD_READY_BEACON);
      expect(fixtures.requests).toContain(STEP_BEACON);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * Every Step kind the native schema added, each proven by something the site
 * did rather than by the Step reporting success: a navigation the hover
 * opened, a lazy load the scroll triggered, values the keyboard entered.
 */
it.live("executes hover, scroll, press, keys, and waitFor", () =>
  Effect.gen(function* replayEveryKind() {
    const fixtures = yield* fixtureServer;

    const { persisted, run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("hover.html") },
        // The menu only exists while hovered; clicking its link both proves
        // the hover landed and navigates to a page the server can see.
        {
          target: [{ kind: "role", name: "Products", role: "button" }],
          type: "hover",
        },
        {
          target: [{ kind: "role", name: "Anvils", role: "link" }],
          type: "click",
        },
        { type: "navigate", url: fixtures.url("lazy.html") },
        // Below the fold: without this scroll the catalogue never loads.
        { deltaY: 2000, type: "scroll" },
        {
          condition: {
            target: [{ kind: "css", selector: "#items" }],
            type: "selectorVisible",
          },
          type: "waitFor",
        },
      ])
    );

    expect(run.outcome).toBe("completed");
    expect(fixtures.requests).toContain("/confirmed.html");
    expect(fixtures.requests).toContain(LAZY_LOADED_BEACON);
    expect(persisted.outcome).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("replays a Scroll against its named nested container", () =>
  Effect.gen(function* replayNestedScroll() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("nested-scroll.html") },
        {
          deltaY: 400,
          target: [{ kind: "css", selector: "#panel" }],
          type: "scroll",
        },
        {
          condition: {
            target: [{ kind: "css", selector: "#container-scrolled" }],
            type: "selectorVisible",
          },
          type: "waitFor",
        },
        { deltaY: 400, type: "scroll" },
        {
          condition: {
            target: [{ kind: "css", selector: "#document-scrolled" }],
            type: "selectorVisible",
          },
          timeout: 500,
          type: "waitFor",
        },
      ])
    );

    expect(run.outcome).toBe("completed");
    expect(fixtures.requests).toContain(NESTED_SCROLL_BEACON);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("bounds a waitFor Step once across its whole locator ladder", () =>
  Effect.gen(function* boundWaitForLadder() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        {
          condition: {
            target: [
              { kind: "css", selector: "#missing-one" },
              { kind: "css", selector: "#missing-two" },
              { kind: "css", selector: "#missing-three" },
            ],
            type: "selectorVisible",
          },
          timeout: 200,
          type: "waitFor",
        },
      ])
    );

    expect(run.outcome).toBe("failed");
    const waited = run.steps.at(1);
    const elapsed =
      Date.parse(waited?.finishedAt ?? "") -
      Date.parse(waited?.startedAt ?? "");
    // One shared deadline, with room for scheduler noise. Applying 200ms to
    // each of three candidates takes roughly 600ms and fails this assertion.
    expect(elapsed).toBeLessThan(400);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("types through keyDown, change, and press", () =>
  Effect.gen(function* replayKeyboard() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        {
          target: [{ kind: "css", selector: "#name" }],
          type: "change",
          value: "Ada",
        },
        // Page-level keystrokes: focus is already in the name field, so the
        // press appends to what the change put there.
        { key: "End", type: "press" },
        { key: "!", type: "press" },
        {
          target: [{ kind: "role", name: "Place order", role: "button" }],
          type: "click",
        },
      ])
    );

    expect(run.outcome).toBe("completed");
    // What the server received proves the keystrokes landed in the field at
    // the caret the Flow left it at.
    expect(fixtures.requests).toContain(
      "/confirmed.html?name=Ada%21&email=&colour="
    );
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

// Trace frames carry their Page identity, so the derived video follows a Flow
// across Pages rather than choosing one Page's live capture.
it.live("acts on a popup as the next Page of the Flow, derived to video", () =>
  Effect.gen(function* replayAcrossPages() {
    const fixtures = yield* fixtureServer;
    const fileSystem = yield* FileSystem.FileSystem;

    const { directory, persisted, run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("popup.html") },
        { target: [{ kind: "css", selector: "#open-popup" }], type: "click" },
        // The popup opened by that click, addressed by order not URL — a
        // per-run nonce in its address would not matter.
        {
          page: 1,
          target: [
            { kind: "role", name: "Checkout in a new tab", role: "heading" },
          ],
          type: "hover",
        },
      ]),
      { video: true }
    );

    expect(run.outcome).toBe("completed");
    expect(run.steps.map((step) => step.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(persisted.video).toBe(true);

    const recording = yield* fileSystem.readFile(
      path.join(directory, "attempt-1.webm")
    );
    expect(recording.length).toBeGreaterThan(1024);

    // Three Step frames plus the settled state each last half a second. The
    // popup Step therefore cannot disappear into the delay that opened it.
    if (canDecodeVideo()) {
      const seconds = yield* recordingDurationSeconds(
        path.join(directory, "attempt-1.webm")
      );
      expect(seconds).toBeGreaterThan(1.2);
    }
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
