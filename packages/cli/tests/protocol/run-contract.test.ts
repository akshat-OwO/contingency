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
  describeSettlingDiagnostic,
  playheadAtSeconds,
  runVideoPath,
  settledFrameSeconds,
  settlingDiagnostic,
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

const environmentWith = <Extra extends object>(extra?: Extra) => ({
  architecture: "arm64",
  cpuCount: 8,
  cpuModel: "Apple M2",
  loadAverage: 1.25,
  memoryBytes: 17_179_869_184,
  platform: "darwin",
  ...extra,
});

const assertDecodes = <Input>(input: Input): RunEnvironmentType => {
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

const runWith = <Extra extends object>(extra?: Extra) => ({
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

const assertRunDecodes = <Input>(input: Input): RunType => {
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

test("a completed Scroll can record a non-failing readiness diagnostic", () => {
  const scrollStep = {
    finishedAt: "2026-01-01T00:00:01.000Z",
    index: 0,
    outcome: "completed",
    scrollReadiness: {
      pendingRequests: 1,
      unsettled: ["dom-mutations", "finite-requests"],
      waitDurationMs: 350,
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    type: "scroll",
  };
  const run = assertRunDecodes(runWith({ steps: [scrollStep] }));

  expect(run.outcome).toBe("completed");
  expect(run.steps[0]?.scrollReadiness).toEqual(scrollStep.scrollReadiness);
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
  }) satisfies RunAttemptType;

test("the attempt worth watching is the last failed one", () => {
  expect(
    defaultAttempt({
      attempts: [attemptWith(1, "failed"), attemptWith(2, "completed")],
    })
  ).toBe(1);
  // Nothing failed, so the last attempt is both the failed answer's fallback
  // and the only one there is.
  expect(
    defaultAttempt({
      attempts: [attemptWith(1, "completed")],
    })
  ).toBe(1);
  expect(
    defaultAttempt({
      attempts: [
        attemptWith(1, "failed"),
        attemptWith(2, "failed"),
        attemptWith(3, "completed"),
      ],
    })
  ).toBe(2);
});

test("a Step seeks to the beginning of its own frame", () => {
  const segment: RunVideoSegmentType = {
    attempt: 1,
    file: "attempt-1.webm",
    includesSettledState: true,
    recorded: true,
    steps: [0, 1, 2],
  };
  // One frame per executed Step in order, each held the same length: the seek
  // is arithmetic on the segment's own list rather than a second index.
  expect(stepFrameSeconds(segment, 0)).toBe(0);
  expect(stepFrameSeconds(segment, 1)).toBe(VIDEO_FRAME_DURATION_SECONDS);
  expect(stepFrameSeconds(segment, 2)).toBe(VIDEO_FRAME_DURATION_SECONDS * 2);
  // The settled-state frame occupies the last complete interval, after the
  // final Step, through the video's declared duration.
  expect(settledFrameSeconds(segment)).toBe(VIDEO_FRAME_DURATION_SECONDS * 3);
  // An attempt that failed before a Step has no frame for it, which is not
  // the same as a frame at zero.
  expect(stepFrameSeconds(segment, 3)).toBeUndefined();
});

test("the playhead names the frame that owns each boundary", () => {
  const segment: RunVideoSegmentType = {
    attempt: 1,
    file: "attempt-1.webm",
    includesSettledState: true,
    recorded: true,
    steps: [0, 1, 2],
  };
  const duration = VIDEO_FRAME_DURATION_SECONDS * 4;
  expect(playheadAtSeconds(segment, 0)).toEqual({ index: 0, kind: "step" });
  expect(playheadAtSeconds(segment, VIDEO_FRAME_DURATION_SECONDS)).toEqual({
    index: 1,
    kind: "step",
  });
  expect(playheadAtSeconds(segment, VIDEO_FRAME_DURATION_SECONDS * 2)).toEqual({
    index: 2,
    kind: "step",
  });
  expect(playheadAtSeconds(segment, VIDEO_FRAME_DURATION_SECONDS * 3)).toEqual({
    kind: "settled",
  });
  // Exactly at the declared duration still belongs to the settled interval,
  // not to a fictional extra frame past the end.
  expect(playheadAtSeconds(segment, duration)).toEqual({ kind: "settled" });
});

test("a missing settled frame is not invented from the last Step", () => {
  const segment: RunVideoSegmentType = {
    attempt: 1,
    error: "The Trace did not capture the final settled state.",
    file: "attempt-1.webm",
    includesSettledState: false,
    recorded: false,
    steps: [0, 1, 2],
  };
  expect(settledFrameSeconds(segment)).toBeUndefined();
  expect(playheadAtSeconds(segment, VIDEO_FRAME_DURATION_SECONDS * 3)).toEqual({
    index: 2,
    kind: "step",
  });
  expect(playheadAtSeconds(segment, VIDEO_FRAME_DURATION_SECONDS * 2)).toEqual({
    index: 2,
    kind: "step",
  });
});

test("a settling diagnostic is recorded only when something still prevented settlement", () => {
  expect(settlingDiagnostic(0, [])).toBeUndefined();
  expect(settlingDiagnostic(2000, ["network idle"])).toEqual({
    remaining: ["network idle"],
    waitMs: 2000,
  });
  expect(
    describeSettlingDiagnostic({
      remaining: ["network idle", "DOM mutations"],
      waitMs: 2000,
    })
  ).toBe(
    "Waited 2000ms; network idle and DOM mutations still prevented settlement."
  );
});

test("an attempt may carry a settling diagnostic without changing the outcome", () => {
  const run = assertRunDecodes(
    runWith({
      attempts: [
        {
          attempt: 1,
          finishedAt: "2026-01-01T00:00:01.000Z",
          outcome: "completed",
          settling: {
            remaining: ["network idle"],
            waitMs: 2000,
          },
          startedAt: "2026-01-01T00:00:00.000Z",
          steps: [],
        },
      ],
    })
  );
  expect(run.outcome).toBe("completed");
  expect(run.attempts[0]?.settling).toEqual({
    remaining: ["network idle"],
    waitMs: 2000,
  });
});

const snapshotWith = (phase: RunPhaseType): Pick<RunSnapshotType, "phase"> => ({
  phase,
});

test("both sides address a derived video by the same path", () => {
  expect(runVideoPath("2f8c-41", 2)).toBe("/runs/2f8c-41/video/2");
  // The route matches on `:runId`, so a Run id that needs escaping must not
  // silently address a different segment of the path.
  expect(runVideoPath("a/b", 1)).toBe("/runs/a%2Fb/video/1");
});

test("a Run in flight cannot be started again", () => {
  expect(runIsInFlight(snapshotWith("starting"))).toBe(true);
  expect(runIsInFlight(snapshotWith("running"))).toBe(true);
  expect(runIsInFlight(snapshotWith("idle"))).toBe(false);
  expect(runIsInFlight(snapshotWith("finished"))).toBe(false);
  expect(runIsInFlight(null)).toBe(false);
});
