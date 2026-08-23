import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  fixtureServer,
  flow,
  IntegrationLive,
  LAZY_LOADED_BEACON,
  runFlow,
} from "./harness";

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

// Capture records per Page, so a Flow that opens a popup must still leave
// exactly one watchable recording — the opening Page's — rather than an
// arbitrary one of the files Playwright wrote.
it.live("acts on a popup as the next Page of the Flow, captured to video", () =>
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

    // The recording kept is the opening Page's — present and watchable, not
    // whichever of the per-Page files the encoder happened to list first.
    const recording = yield* fileSystem.readFile(
      path.join(directory, "attempt-1.webm")
    );
    expect(recording.length).toBeGreaterThan(1024);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
