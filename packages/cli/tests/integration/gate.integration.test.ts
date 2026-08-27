import {
  runBreachedGate,
  runExitCode,
  runIsBaselineEligible,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

/**
 * A Gate holds a Flow to accessibility rule ids that must produce no Finding
 * ([ADR 0018](../../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)).
 *
 * Every claim here is read off a Run produced by auditing a real page, because
 * the risk this ticket carries is not whether a predicate returns the right
 * boolean — it is whether a breach leaks into the Run's outcome and quietly
 * destroys Baseline eligibility for the Runs most worth comparing against.
 *
 * The violations fixture trips `image-alt`, `label`, `button-name`,
 * `link-name`, and `document-title`. The checkout fixture trips none of them.
 */
const auditing = (url: string) =>
  flow([
    { type: "navigate", url },
    { kind: "accessibility", type: "audit" },
  ]);

it.live(
  "reports every violation and fails nothing when no Gate is declared",
  () =>
    Effect.gen(function* noGate() {
      const fixtures = yield* fixtureServer;

      const { persisted, run } = yield* runFlow(
        auditing(fixtures.url("violations.html"))
      );

      expect((run.steps.at(1)?.findings ?? []).length).toBeGreaterThan(0);
      // Held to no bar, so the Run records none: an absent Gate and a Gate that
      // was met are different evidence, and the artifact must not conflate them.
      expect(run.gate).toBeUndefined();
      expect(persisted.gate).toBeUndefined();
      expect(run.outcome).toBe("completed");
      expect(runExitCode(run)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("breaches a Gate the audited page misses, and says which rules", () =>
  Effect.gen(function* breachGate() {
    const fixtures = yield* fixtureServer;

    const { persisted, run } = yield* runFlow({
      ...auditing(fixtures.url("violations.html")),
      // `html-has-lang` is in the Gate and never trips: the fixture declares a
      // language. A Gate rule the page passes must not be reported as
      // breached alongside the ones it fails.
      gate: ["label", "html-has-lang", "image-alt"],
    });

    // In the Gate's own order, not the order the engine happened to report.
    expect(run.gate?.breached).toEqual(["label", "image-alt"]);
    expect(run.gate?.rules).toEqual(["label", "html-has-lang", "image-alt"]);
    expect(run.gate?.source).toBe("flow");
    // The Run artifact carries the breach, not just the in-memory Run.
    expect(persisted.gate).toEqual(run.gate);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("leaves a breaching Run completed and changes only the exit code", () =>
  Effect.gen(function* breachIsNotFailure() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...auditing(fixtures.url("violations.html")),
      gate: ["image-alt"],
    });

    expect(run.outcome).toBe("completed");
    expect(run.failure).toBeUndefined();
    // Every Step executed. The site missed the bar; the Run did not fail.
    expect(run.steps.every((step) => step.outcome === "completed")).toBe(true);
    expect(runBreachedGate(run)).toBe(true);
    expect(runExitCode(run)).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("keeps a Gate-breaching Run eligible as a Baseline", () =>
  Effect.gen(function* breachStaysEligible() {
    const fixtures = yield* fixtureServer;

    const { persisted, run } = yield* runFlow({
      ...auditing(fixtures.url("violations.html")),
      gate: ["image-alt"],
    });

    expect(runBreachedGate(run)).toBe(true);
    // This is the trap the ADR names. Implementing a breach as a failed
    // outcome would silently destroy eligibility for exactly the Runs worth
    // comparing against: the ones documenting today's known-bad state.
    expect(runIsBaselineEligible(run)).toBe(true);
    expect(runIsBaselineEligible(persisted)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("records a Gate the page meets, and exits zero", () =>
  Effect.gen(function* gateMet() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...auditing(fixtures.url("checkout.html")),
      gate: ["image-alt", "label", "button-name"],
    });

    expect(run.gate?.breached).toEqual([]);
    expect(run.gate?.rules).toEqual(["image-alt", "label", "button-name"]);
    expect(runExitCode(run)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("holds a Run to the Gate its invocation supplied, not the Flow's", () =>
  Effect.gen(function* overrideGate() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      {
        ...auditing(fixtures.url("violations.html")),
        gate: ["image-alt"],
      },
      // Relaxed at invocation to a rule this page passes, without editing the
      // Flow. The Flow's own `image-alt` breach must not survive the override.
      { gate: ["html-has-lang"] }
    );

    expect(run.gate?.rules).toEqual(["html-has-lang"]);
    expect(run.gate?.breached).toEqual([]);
    expect(run.gate?.source).toBe("invocation");
    expect(runExitCode(run)).toBe(0);
    // The Flow the Run embeds still says what it was authored to hold, so the
    // override is visible as an override rather than as a rewritten Flow.
    expect(run.flow.gate).toEqual(["image-alt"]);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("reports a Run that did not complete as broken, not as a breach", () =>
  Effect.gen(function* incompleteRunIsNotABreach() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow({
      ...flow([
        { type: "navigate", url: fixtures.url("violations.html") },
        { kind: "accessibility", type: "audit" },
        {
          target: [{ kind: "role", name: "Nothing here", role: "button" }],
          timeout: 1000,
          type: "click",
        },
      ]),
      gate: ["image-alt"],
    });

    expect(run.outcome).toBe("failed");
    // The Findings are real and the Gate is recorded as breached, but a Run
    // that stopped early has not established that the Gate's other rules
    // pass. CI must read this as a broken check, not a regressed site.
    expect(run.gate?.breached).toEqual(["image-alt"]);
    expect(runExitCode(run)).toBe(1);
    expect(runIsBaselineEligible(run)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("refuses a malformed Gate before it can write an unreadable Run", () =>
  Effect.gen(function* refuseMalformedGate() {
    const fixtures = yield* fixtureServer;

    // What an interpolated CI variable that came up empty looks like by the
    // time it reaches the Runner.
    const outcome = yield* Effect.result(
      runFlow(auditing(fixtures.url("violations.html")), { gate: [""] })
    );

    // Refused rather than persisted: an empty rule id would land in
    // `RunGate.rules` verbatim and produce a `run.json` that the protocol's
    // own decode rejects, discovered only by whoever next reads the artifact.
    expect(outcome._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
