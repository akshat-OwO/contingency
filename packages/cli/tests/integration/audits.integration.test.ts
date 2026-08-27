import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

/**
 * The violations fixture maps each element to the axe rule that flags it.
 * These tests assert on Findings against real pages — coverage that moved
 * here when the fake-browser unit tests were deleted.
 */
it.live("reports every violation an Audit finds", () =>
  Effect.gen(function* reportFindings() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("violations.html") },
        { kind: "accessibility", type: "audit" },
      ])
    );

    expect(run.outcome).toBe("completed");
    const audit = run.steps.at(1);
    expect(audit?.outcome).toBe("completed");
    const findings = audit?.findings ?? [];
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.stepIndex).toBe(1);
      // Every Finding names where on the page it is about.
      expect(finding.target).not.toBe("");
    }
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("audits a clean page without findings", () =>
  Effect.gen(function* cleanAudit() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        { kind: "accessibility", type: "audit" },
      ])
    );

    expect(run.outcome).toBe("completed");
    const audit = run.steps.at(1);
    // The checkout form is labelled throughout, so nothing trips.
    expect(audit?.findings ?? []).toEqual([]);
    expect(audit?.elidedFindings).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
