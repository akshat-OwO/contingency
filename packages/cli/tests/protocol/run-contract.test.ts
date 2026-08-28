import type {
  Run as RunType,
  RunAttempt as RunAttemptType,
  RunEnvironment as RunEnvironmentType,
  RunPhase as RunPhaseType,
  RunSnapshot as RunSnapshotType,
  RunVideoSegment as RunVideoSegmentType,
} from "@contingency/protocol";
import {
  axeVersionMismatchWarning,
  defaultAttempt,
  gateBreaches,
  Run,
  runBreachedGate,
  RunEnvironment,
  runExitCode,
  runIsBaselineEligible,
  runIsInFlight,
  stepFrameSeconds,
  VIDEO_FRAME_DURATION_SECONDS,
} from "@contingency/protocol";
import { Result, Schema, SchemaIssue } from "effect";
import { expect, test } from "vitest";

/**
 * The Run's environment decodes strictly: an unknown field means a document
 * from another era, and ignoring it would silently drop whatever the Run
 * recorded.
 */
const decode = Schema.decodeUnknownResult(RunEnvironment, {
  onExcessProperty: "error",
});
const formatIssue = SchemaIssue.makeFormatterDefault();

const environmentWith = (extra?: Record<string, unknown>) => ({
  architecture: "arm64",
  cpuCount: 8,
  cpuModel: "Apple M2",
  loadAverage: 1.25,
  memoryBytes: 17_179_869_184,
  platform: "darwin",
  ...extra,
});

const assertDecodes = (input: unknown): RunEnvironmentType => {
  const result = decode(input);
  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the environment to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  return result.success;
};

test("a Run that audited nothing records no engine version", () => {
  const environment = assertDecodes(environmentWith());
  expect(environment.axeVersion).toBeUndefined();
  expect(environment.navigationReadiness).toBeUndefined();
});

test("a new Run records its bounded navigation readiness contract", () => {
  const environment = assertDecodes(
    environmentWith({
      navigationReadiness: "load-then-bounded-network-idle",
    })
  );
  expect(environment.navigationReadiness).toBe(
    "load-then-bounded-network-idle"
  );
});

test("a Run that audited something records the pinned engine version", () => {
  const environment = assertDecodes(environmentWith({ axeVersion: "4.13.0" }));
  expect(environment.axeVersion).toBe("4.13.0");
});

test("an engine version must be a non-empty string", () => {
  expect(Result.isSuccess(decode(environmentWith({ axeVersion: "" })))).toBe(
    false
  );
});

test("a comparison across an engine upgrade warns rather than refuses", () => {
  const warning = axeVersionMismatchWarning(
    assertDecodes(environmentWith({ axeVersion: "4.12.0" })),
    assertDecodes(environmentWith({ axeVersion: "4.13.0" }))
  );
  expect(warning).toContain("4.12.0");
  expect(warning).toContain("4.13.0");
});

test("the same engine, or an unrecorded one, warns nothing", () => {
  const same = assertDecodes(environmentWith({ axeVersion: "4.13.0" }));
  const unrecorded = assertDecodes(environmentWith());
  expect(axeVersionMismatchWarning(same, same)).toBeUndefined();
  expect(axeVersionMismatchWarning(unrecorded, same)).toBeUndefined();
  expect(axeVersionMismatchWarning(same, unrecorded)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const decodeRun = Schema.decodeUnknownResult(Run, {
  onExcessProperty: "error",
});

const runWith = (extra?: Record<string, unknown>) => ({
  attempts: [
    {
      attempt: 1,
      finishedAt: "2026-01-01T00:00:01.000Z",
      outcome: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      steps: [],
    },
  ],
  environment: environmentWith(),
  finishedAt: "2026-01-01T00:00:01.000Z",
  flow: {
    steps: [{ type: "navigate", url: "https://example.com" }],
    title: "Contract",
  },
  flowHash: "hash",
  flowId: "hash",
  outcome: "completed",
  runId: "run",
  startedAt: "2026-01-01T00:00:00.000Z",
  steps: [],
  trace: true,
  video: false,
  ...extra,
});

const assertRunDecodes = (input: unknown): RunType => {
  const result = decodeRun(input);
  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the Run to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  return result.success;
};

test("one accessibility rule decodes as one Finding with a bounded node sample", () => {
  const auditStep = {
    findings: [
      {
        helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
        message: "Images must have alternative text",
        nodeCount: 42,
        nodes: [
          { message: "Element does not have an alt attribute", target: "img" },
        ],
        rule: "image-alt",
        severity: "critical",
        stepIndex: 0,
      },
    ],
    finishedAt: "2026-01-01T00:00:01.000Z",
    index: 0,
    outcome: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    type: "audit",
  };
  const run = assertRunDecodes(
    runWith({
      attempts: [
        {
          attempt: 1,
          finishedAt: "2026-01-01T00:00:01.000Z",
          outcome: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          steps: [auditStep],
        },
      ],
      steps: [auditStep],
    })
  );
  expect(run.steps[0]?.findings?.[0]).toMatchObject({
    nodeCount: 42,
    nodes: [{ target: "img" }],
    rule: "image-alt",
  });
});

test("the former per-element Finding shape no longer decodes", () => {
  const oldFinding = {
    message: "Images must have alternative text",
    rule: "image-alt",
    severity: "critical",
    stepIndex: 0,
    target: "img",
  };
  const step = {
    findings: [oldFinding],
    finishedAt: "2026-01-01T00:00:01.000Z",
    index: 0,
    outcome: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    type: "audit",
  };
  expect(Result.isSuccess(decodeRun(runWith({ steps: [step] })))).toBe(false);
});

test("a Run held to no Gate records none and exits zero", () => {
  const run = assertRunDecodes(runWith());
  expect(run.gate).toBeUndefined();
  expect(runBreachedGate(run)).toBe(false);
  expect(runExitCode(run)).toBe(0);
});

test("a Run records the Gate it met, not only the one it breached", () => {
  const run = assertRunDecodes(
    runWith({
      gate: { breached: [], rules: ["image-alt"], source: "flow" },
    })
  );
  // Meeting a bar and being held to no bar are different evidence, and a
  // later comparison cannot recover the difference from an absent field.
  expect(run.gate?.rules).toEqual(["image-alt"]);
  expect(runExitCode(run)).toBe(0);
});

test("a Run records which Gate rules it breached, and where the bar came from", () => {
  const run = assertRunDecodes(
    runWith({
      gate: {
        breached: ["image-alt"],
        rules: ["image-alt", "label"],
        source: "invocation",
      },
    })
  );
  expect(run.gate?.breached).toEqual(["image-alt"]);
  expect(run.gate?.source).toBe("invocation");
});

test("a Gate names at least one rule", () => {
  expect(
    Result.isSuccess(
      decodeRun(runWith({ gate: { breached: [], rules: [], source: "flow" } }))
    )
  ).toBe(false);
});

test("a breach leaves the outcome completed and only changes the exit code", () => {
  const run = assertRunDecodes(
    runWith({
      gate: { breached: ["label"], rules: ["label"], source: "flow" },
    })
  );
  expect(run.outcome).toBe("completed");
  expect(runBreachedGate(run)).toBe(true);
  expect(runExitCode(run)).toBe(2);
});

test("a Gate-breaching Run remains eligible as a Baseline", () => {
  const breaching = assertRunDecodes(
    runWith({
      gate: { breached: ["label"], rules: ["label"], source: "flow" },
    })
  );
  // Baseline eligibility keys on outcome alone (ADR 0018). Implementing a
  // breach as a failed outcome would silently destroy eligibility for exactly
  // the Runs most worth comparing against: the ones documenting today's
  // known-bad state.
  expect(runIsBaselineEligible(breaching)).toBe(true);
});

test("a Run that did not complete exits one, breach or not", () => {
  const failed = assertRunDecodes(
    runWith({
      attempts: [
        {
          attempt: 1,
          failure: { message: "The Step did not resolve." },
          finishedAt: "2026-01-01T00:00:01.000Z",
          outcome: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          steps: [],
        },
      ],
      failure: { message: "The Step did not resolve." },
      gate: { breached: ["label"], rules: ["label"], source: "flow" },
      outcome: "failed",
    })
  );
  // A Run that stopped early has not established that the Gate's other rules
  // pass, so it reports the broken check rather than the missed bar.
  expect(runExitCode(failed)).toBe(1);
  expect(runIsBaselineEligible(failed)).toBe(false);
});

test("a breach is the Gate rules that a Finding was raised against, in Gate order", () => {
  expect(
    gateBreaches(
      ["label", "image-alt", "link-name"],
      [{ rule: "image-alt" }, { rule: "image-alt" }, { rule: "document-title" }]
    )
    // A rule outside the Gate is reported and never fails anything, and a
    // breached rule is named once however many elements it flagged.
  ).toEqual(["image-alt"]);
});

const attemptWith = (attempt: number, outcome: "completed" | "failed") =>
  ({
    attempt,
    finishedAt: "2026-01-01T00:00:01.000Z",
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
  }) as RunAttemptType;

test("the attempt worth watching is the last failed one", () => {
  expect(
    defaultAttempt({
      attempts: [attemptWith(1, "failed"), attemptWith(2, "completed")],
    } as unknown as RunType)
  ).toBe(1);
  // Nothing failed, so the last attempt is both the failed answer's fallback
  // and the only one there is.
  expect(
    defaultAttempt({
      attempts: [attemptWith(1, "completed")],
    } as unknown as RunType)
  ).toBe(1);
  expect(
    defaultAttempt({
      attempts: [
        attemptWith(1, "failed"),
        attemptWith(2, "failed"),
        attemptWith(3, "completed"),
      ],
    } as unknown as RunType)
  ).toBe(2);
});

test("a Step seeks to the middle of its own frame, never a boundary", () => {
  const segment: RunVideoSegmentType = {
    attempt: 1,
    file: "attempt-1.webm",
    includesSettledState: true,
    recorded: true,
    steps: [0, 1, 2],
  };
  // One frame per executed Step in order, each held the same length: the seek
  // is arithmetic on the segment's own list rather than a second index.
  expect(stepFrameSeconds(segment, 0)).toBe(VIDEO_FRAME_DURATION_SECONDS / 2);
  expect(stepFrameSeconds(segment, 2)).toBe(VIDEO_FRAME_DURATION_SECONDS * 2.5);
  // An attempt that failed before a Step has no frame for it, which is not
  // the same as a frame at zero.
  expect(stepFrameSeconds(segment, 3)).toBeUndefined();
});

const snapshotWith = (phase: RunPhaseType): RunSnapshotType =>
  ({ phase }) as RunSnapshotType;

test("a Run in flight cannot be started again", () => {
  expect(runIsInFlight(snapshotWith("starting"))).toBe(true);
  expect(runIsInFlight(snapshotWith("running"))).toBe(true);
  expect(runIsInFlight(snapshotWith("idle"))).toBe(false);
  expect(runIsInFlight(snapshotWith("finished"))).toBe(false);
  expect(runIsInFlight(null)).toBe(false);
});
