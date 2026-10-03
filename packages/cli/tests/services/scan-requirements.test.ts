import { scanCoverage } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  parseScanRequirements,
  requestedScans,
  validateTaughtScans,
} from "../../src/services/scan-requirements.ts";

const requirement = {
  id: "cart-scan",
  mode: "timespan" as const,
  when: "Cart drawer opens",
};
const files = () => [
  {
    content:
      "Read [scans](references/scans.json). Start cart-scan when the drawer opens.",
    path: "SKILL.md",
  },
  {
    content: JSON.stringify({ requirements: [requirement], schemaVersion: 1 }),
    path: "references/scans.json",
  },
];

it.effect(
  "unmatched taught timespans remain drafts but cannot start Runs",
  () =>
    Effect.gen(function* checkDraft() {
      expect(Result.isSuccess(parseScanRequirements(files()))).toBe(true);
      yield* validateTaughtScans(files(), [
        { scan: { id: requirement.id, mode: "timespan", phase: "start" } },
      ]);
      const failure = yield* Effect.flip(
        requestedScans([{ files: files(), name: "cart" }])
      );
      expect(failure.message).toContain("endWhen");
    })
);

it.effect("learning cannot drop a taught scan or its taught stop", () =>
  Effect.gen(function* preserveIntent() {
    const events = [
      {
        scan: {
          id: requirement.id,
          mode: "timespan" as const,
          phase: "start" as const,
        },
      },
      {
        scan: {
          id: requirement.id,
          mode: "timespan" as const,
          phase: "stop" as const,
        },
      },
    ];
    const missing = yield* Effect.flip(validateTaughtScans([], events));
    expect(missing.message).toContain("Preserve every taught scan");
    const missingStop = yield* Effect.flip(
      validateTaughtScans(files(), events)
    );
    expect(missingStop.message).toContain("endWhen");
  })
);

it("coverage requires completed reports matching skill and stable requirement ID", () => {
  const reference = {
    ...requirement,
    endWhen: "Cart total is visible",
    flowSkillName: "cart",
  };
  const report = {
    flowSkillName: "cart",
    id: "scan-report",
    mode: "timespan" as const,
    requirementId: requirement.id,
    startedAt: "2026-10-03T00:00:00Z",
    summary: "Collected",
    tabId: "tab-1",
    url: "http://localhost/cart",
  };
  expect(
    scanCoverage({
      scanReports: [{ ...report, status: "partial" }],
      scanRequirements: [reference],
    }).complete
  ).toBe(false);
  expect(
    scanCoverage({
      scanReports: [{ ...report, flowSkillName: "other", status: "completed" }],
      scanRequirements: [reference],
    }).complete
  ).toBe(false);
  expect(
    scanCoverage({
      scanReports: [{ ...report, status: "completed" }],
      scanRequirements: [reference],
    }).complete
  ).toBe(true);
  expect(
    scanCoverage({
      scanRequirements: [
        {
          ...reference,
          outsideScope: "The user requested only the catalogue.",
        },
      ],
    }).total
  ).toBe(0);
});

it("navigation scans cannot silently omit their expected destination", () => {
  const malformed = files().map((file) =>
    file.path === "references/scans.json"
      ? {
          ...file,
          content: JSON.stringify({
            requirements: [{ ...requirement, mode: "navigation" }],
            schemaVersion: 1,
          }),
        }
      : file
  );
  const parsed = parseScanRequirements(malformed);
  expect(Result.isFailure(parsed)).toBe(true);
  if (Result.isFailure(parsed)) {
    expect(parsed.failure.message).toContain("expectedUrl");
  }
});
