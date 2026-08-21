import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

// `it.live`, not `it.effect`: a real browser runs on the real clock, and a
// Runner that waits for anything would wait forever against a test clock.
it.live("resolves navigate, fill, and click selectors against real DOM", () =>
  Effect.gen(function* replayAgainstRealDom() {
    const fixtures = yield* fixtureServer;

    const { persisted, run } = yield* runFlow(
      flow(
        [
          { type: "navigate", url: fixtures.url("checkout.html") },
          // An id, the plainest case.
          {
            selectors: [["#name"]],
            type: "change",
            value: "Ada Lovelace",
          },
          // No id: the Recorder would offer alternatives, and the Runner has
          // to get through one of them against the real document.
          {
            selectors: [["#missing-since-the-redesign"], ['[name="email"]']],
            type: "change",
            value: "ada@example.com",
          },
          {
            assertedEvents: [
              {
                title: "Order confirmed",
                type: "navigation",
                url: fixtures.url("confirmed.html"),
              },
            ],
            offsetX: 1,
            offsetY: 1,
            selectors: [["#submit"]],
            type: "click",
          },
        ],
        "Checkout"
      )
    );

    expect(run.outcome).toBe("completed");
    expect(run.steps.map((step) => step.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // What the server received proves the values landed in the fields the
    // Flow named, which a completed Step on its own does not.
    expect(fixtures.requests).toContain(
      "/confirmed.html?name=Ada+Lovelace&email=ada%40example.com"
    );
    // A Run that never reached disk is not a Run.
    expect(persisted.runId).toBe(run.runId);
    expect(persisted.outcome).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
