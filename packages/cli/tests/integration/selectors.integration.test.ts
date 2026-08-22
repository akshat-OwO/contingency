import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

// `it.live`, not `it.effect`: a real browser runs on the real clock, and a
// Runner that waits for anything would wait forever against a test clock.
it.live("resolves navigate, fill, select, and click against real DOM", () =>
  Effect.gen(function* replayAgainstRealDom() {
    const fixtures = yield* fixtureServer;

    const { persisted, run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        // An id, the plainest case.
        {
          target: [{ kind: "css", selector: "#name" }],
          type: "change",
          value: "Ada Lovelace",
        },
        // A stale alternative first: the ladder tries it, moves on, and the
        // label strategy resolves what the redesign renamed.
        {
          target: [
            { kind: "css", selector: "#missing-since-the-redesign" },
            { kind: "label", label: "Email" },
          ],
          type: "change",
          value: "ada@example.com",
        },
        {
          target: [
            {
              kind: "role",
              name: "Colour",
              role: "combobox",
            },
          ],
          type: "selectOption",
          values: ["blue"],
        },
        {
          target: [
            { kind: "role", name: "Place order", role: "button" },
            { kind: "css", selector: "#submit" },
          ],
          type: "click",
        },
      ])
    );

    expect(run.outcome).toBe("completed");
    expect(run.steps.map((step) => step.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // What the server received proves the values landed in the fields the
    // Flow named, which a completed Step on its own does not.
    expect(fixtures.requests).toContain(
      "/confirmed.html?name=Ada+Lovelace&email=ada%40example.com&colour=blue"
    );
    // A Run that never reached disk is not a Run.
    expect(persisted.runId).toBe(run.runId);
    expect(persisted.outcome).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
