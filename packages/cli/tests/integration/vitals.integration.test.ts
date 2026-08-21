import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

/**
 * An uncaptured headless Run is the environment where paint metrics are least
 * dependable: the browser paints only when it has reason to, and a Run that
 * navigates and stops does not always give it one (ADR 0008). What this suite
 * pins is not that every metric is always present — that would be a lie the
 * browser itself disproves — but the contract around their absence:
 *
 * - A measurement that cannot be taken never fails the Step or the Run.
 * - The toggled Step still carries the metrics the page did produce: TTFB
 *   from the navigation entry, CLS from a page with no shifts.
 * - A metric the page did not produce is recorded as absent, never as zero,
 *   so the fastest possible page stays distinguishable from an unmeasured one.
 * - INP is absent on a Flow that never interacts, because a page nobody has
 *   interacted with has no interaction to report.
 */
it.live("records an uncaptured headless Run's vitals honestly", () =>
  Effect.gen(function* uncapturedVitals() {
    const fixtures = yield* fixtureServer;

    const { persisted } = yield* runFlow(
      flow([
        {
          contingency: { id: "open", performance: true },
          type: "navigate",
          url: fixtures.url("checkout.html"),
        },
      ])
    );

    expect(persisted.outcome).toBe("completed");
    const measured = persisted.steps.find((step) => step.vitals !== undefined);
    expect(measured).toBeDefined();

    const vitals = measured?.vitals;
    // The navigation entry is always there for a page served over HTTP, so a
    // Run without it means the read itself failed, which must be visible.
    expect(vitals?.ttfb).toBeGreaterThan(0);
    expect(vitals?.cls).toBe(0);

    // Paint metrics are present only when the page painted. When they are,
    // they are real numbers; when they are not, they are absent rather than
    // zero — either way, never fabricated.
    if (vitals?.fcp !== undefined) {
      expect(vitals.fcp).toBeGreaterThan(0);
      expect(vitals.lcp).toBeGreaterThan(0);
    }
    expect(vitals?.inp).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
