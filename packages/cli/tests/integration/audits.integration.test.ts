import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

/** The axe-core version the manifest pins, as the engine itself reports it. */
const pinnedAxeVersion = (): string => {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(require.resolve("axe-core/package.json"), "utf-8")
  ) as { version: string };
  return manifest.version;
};

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

it.live("audits twice without the engine's utility page leaking", () =>
  Effect.gen(function* auditTwice() {
    const fixtures = yield* fixtureServer;

    // The wrapper finishes each audit on a utility page of its own, which the
    // Run's Page registry must never absorb: a second Audit reading where the
    // Flow currently is would otherwise find that page, closed.
    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("violations.html") },
        { kind: "accessibility", type: "audit" },
        { kind: "accessibility", type: "audit" },
      ])
    );

    expect(run.outcome).toBe("completed");
    for (const [position, step] of (run.steps ?? []).entries()) {
      if (step.type !== "audit") {
        continue;
      }
      expect(step.outcome).toBe("completed");
      expect(step.error).toBeUndefined();
      expect((step.findings ?? []).length).toBeGreaterThan(0);
      expect(
        step.findings?.every((finding) => finding.stepIndex === position)
      ).toBe(true);
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

it.live(
  "lists a bounded sample per rule and elides the rest with the true count",
  () =>
    Effect.gen(function* elideSurplus() {
      const fixtures = yield* fixtureServer;

      const { run } = yield* runFlow(
        flow([
          { type: "navigate", url: fixtures.url("violations.html") },
          { kind: "accessibility", type: "audit" },
        ])
      );

      expect(run.outcome).toBe("completed");
      const audit = run.steps.at(1);
      const findings = audit?.findings ?? [];
      // Twelve unlabelled images, of which only a sample is listed.
      const images = findings.filter((finding) => finding.rule === "image-alt");
      expect(images).toHaveLength(10);
      expect(audit?.elidedFindings).toEqual([
        {
          reported: 10,
          rule: "image-alt",
          severity: "critical",
          stepIndex: 1,
          total: 12,
        },
      ]);
      // Rules with few violations are listed whole: nothing else is elided.
      for (const finding of findings.filter((f) => f.rule !== "image-alt")) {
        expect(finding.target).not.toBe("");
      }
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("records the pinned engine version in the Run's environment", () =>
  Effect.gen(function* recordEngineVersion() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("violations.html") },
        { kind: "accessibility", type: "audit" },
      ])
    );

    expect(run.environment.axeVersion).toBe(pinnedAxeVersion());
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("records the engine version even when a later Step fails", () =>
  Effect.gen(function* recordEngineVersionOnFailure() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("violations.html") },
        { kind: "accessibility", type: "audit" },
        // Answered by nothing, so the Run fails after the Audit succeeded.
        { type: "navigate", url: fixtures.url("never-answered.bin") },
      ])
    );

    expect(run.outcome).toBe("failed");
    // An Audit that ran recorded its engine; the later failure un-does nothing.
    expect(run.environment.axeVersion).toBe(pinnedAxeVersion());
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("renders frame and shadow-root hops distinguishably", () =>
  Effect.gen(function* auditFramesAndShadowRoots() {
    const fixtures = yield* fixtureServer;
    // The same server, addressed by a different host, so the iframe is
    // genuinely cross-origin — the case only a real frame-tree injection
    // reaches.
    const framedChild = fixtures
      .url("framed-child.html")
      .replace("127.0.0.1", "localhost");

    const { run } = yield* runFlow(
      flow([
        {
          type: "navigate",
          url: `${fixtures.url("framed-audit.html")}?frame=${encodeURIComponent(framedChild)}`,
        },
        { kind: "accessibility", type: "audit" },
      ])
    );

    expect(run.outcome).toBe("completed");
    const audit = run.steps.at(1);
    expect(audit?.outcome).toBe("completed");
    const targets = (audit?.findings ?? []).map((finding) => finding.target);
    // The unlabelled image lives across an iframe boundary.
    expect(targets.some((target) => target.includes(" >>> "))).toBe(true);
    // The empty button lives inside an open shadow root — a different hop.
    expect(targets.some((target) => target.includes(" >> "))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
