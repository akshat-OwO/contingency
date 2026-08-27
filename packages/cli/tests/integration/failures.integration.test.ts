import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

it.live("classifies a failed navigation as the site's fault", () =>
  Effect.gen(function* classifySiteFailure() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        // No fixture serves this path, so the server answers 404: the site
        // under test failed, however well the Flow was authored.
        { type: "navigate", url: fixtures.url("gone.html") },
      ])
    );

    expect(run.outcome).toBe("failed");
    expect(run.failure?.kind).toBe("siteError");
    expect(run.failure?.stepIndex).toBe(0);
    expect(run.steps[0]?.outcome).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("classifies an exhausted locator ladder as a stale Flow", () =>
  Effect.gen(function* classifyFlowFailure() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        {
          target: [
            {
              kind: "role",
              name: "Nothing of this name exists",
              role: "button",
            },
            { kind: "css", selector: "#also-missing" },
            { expression: "//button[@id='still-missing']", kind: "xpath" },
          ],
          type: "click",
        },
      ])
    );

    expect(run.outcome).toBe("failed");
    expect(run.failure?.kind).toBe("flowError");
    // The failure names every strategy tried, so a stale ladder is visible
    // without re-running anything.
    expect(run.failure?.message).toContain("(tried 3)");
    expect(run.failure?.message).toContain("CSS #also-missing");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("retries in fresh contexts and records every attempt", () =>
  Effect.gen(function* retryFailingFlow() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        // Fails on every attempt: the element is genuinely absent, so each
        // retry fails exactly the way the first one did.
        {
          target: [{ kind: "css", selector: "#absent-forever" }],
          type: "click",
        },
      ]),
      { retry: 2 }
    );

    expect(run.outcome).toBe("failed");
    expect(run.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    for (const attempt of run.attempts) {
      expect(attempt.outcome).toBe("failed");
    }
    // The Run's own Steps mirror the last attempt, not the sum of all three.
    expect(run.steps).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("records an unusable urlMatches pattern without failing the Run", () =>
  Effect.gen(function* unusablePattern() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      preSteps: [
        {
          id: "malformed",
          step: {
            target: [{ kind: "css", selector: "#view-cart" }],
            type: "click",
          },
          // An unclosed group: a pattern a Flow can carry but no engine can
          // compile.
          when: { pattern: "https://shop.test/(", type: "urlMatches" },
        },
      ],
      steps: [
        { type: "navigate", url: fixtures.url("shop.html") },
        { target: [{ kind: "css", selector: "#view-cart" }], type: "click" },
      ],
      title: "Unusable pattern",
    });

    // A condition nobody could evaluate is the Pre-step's problem, not the
    // Run's: it is recorded as unanswerable and the journey continues.
    expect(run.outcome).toBe("completed");
    const [preStep] = run.steps[1]?.preSteps ?? [];
    expect(preStep?.outcome).toBe("failed");
    expect(preStep?.error).toContain("regular expression");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
