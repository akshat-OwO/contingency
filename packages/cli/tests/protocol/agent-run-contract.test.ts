import {
  advancesAgentRun,
  AgentAssessmentOutcome,
  agentRunVideoPath,
  AgentRunId,
  AgentRunSummary,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

const decodeSummary = Schema.decodeUnknownSync(AgentRunSummary);

const step = {
  assessment: null,
  attempts: 0,
  confirmation: false,
  description: "Open the catalogue.",
  endedAt: null,
  execution: "pending",
  index: 0,
  name: "Open",
  startedAt: null,
};

const summary = {
  agentFlowId: "flow-catalogue",
  assessmentCounts: {
    blocked: 0,
    inconclusive: 0,
    notWorking: 0,
    working: 1,
  },
  attribution: {
    clientName: "integration-agent",
    clientVersion: "1.0.0",
    reportedMetadataVerified: false,
    reportedModel: "claude-sonnet-5",
    reportedProvider: "anthropic",
  },
  ceilings: { extensions: 0, runMs: 900_000, stepMs: 120_000 },
  coverage: { complete: true, executed: 1, total: 1, unexecuted: 0 },
  endedAt: "2026-09-04T00:01:00.000Z",
  outcome: "completed",
  revisionId: "rev-one",
  runId: "agentrun-one",
  schemaVersion: 1,
  sessionId: "agent-one",
  startedAt: "2026-09-04T00:00:00.000Z",
  steps: [
    {
      ...step,
      assessment: {
        attempts: 2,
        evidence: [{ id: "snapshot-1", kind: "snapshot" }],
        explanation: "The catalogue listed the expected products.",
        outcome: "working",
        submittedAt: "2026-09-04T00:00:30.000Z",
      },
      endedAt: "2026-09-04T00:00:30.000Z",
      execution: "assessed",
      startedAt: "2026-09-04T00:00:01.000Z",
    },
  ],
  summary: "Every Agent Step worked.",
  timeline: [],
  title: "Browse the catalogue",
  tracePath: "run.trace.zip",
  videoPath: "run.webm",
};

test("only a working Agent Assessment advances an Agent Flow", () => {
  const outcomes = AgentAssessmentOutcome.literals;
  expect(outcomes.filter((outcome) => advancesAgentRun(outcome))).toEqual([
    "working",
  ]);
  expect(outcomes).toHaveLength(4);
});

test("a Run Summary reports assessment counts and coverage separately", () => {
  const decoded = decodeSummary(summary);
  expect(decoded.assessmentCounts.working).toBe(1);
  expect(decoded.coverage).toEqual({
    complete: true,
    executed: 1,
    total: 1,
    unexecuted: 0,
  });
  // The execution outcome is a system fact and does not live inside the
  // Agent Assessment it sits beside.
  expect(decoded.steps[0]?.execution).toBe("assessed");
});

test("a timed-out Agent Step carries an execution outcome and no assessment", () => {
  const decoded = decodeSummary({
    ...summary,
    assessmentCounts: {
      blocked: 0,
      inconclusive: 0,
      notWorking: 0,
      working: 0,
    },
    // A timed-out Step was reached but interrupted mid-check, so it counts
    // as executed without making coverage complete.
    coverage: { complete: false, executed: 1, total: 1, unexecuted: 0 },
    outcome: "timed-out",
    steps: [{ ...step, execution: "timed-out" }],
    summary: null,
  });
  expect(decoded.outcome).toBe("timed-out");
  expect(decoded.steps[0]?.assessment).toBeNull();
});

test("client-reported provider and model are recorded as unverified", () => {
  const schema = JSON.stringify(Schema.toJsonSchemaDocument(AgentRunSummary));
  expect(schema).toContain("reportedMetadataVerified");
  expect(decodeSummary(summary).attribution.reportedMetadataVerified).toBe(
    false
  );
});

test("an Agent Assessment cannot be submitted without evidence", () => {
  expect(() =>
    decodeSummary({
      ...summary,
      steps: [
        {
          ...summary.steps[0],
          assessment: {
            ...summary.steps[0]?.assessment,
            evidence: [],
          },
        },
      ],
    })
  ).toThrow();
});

test("a Run's video is served from a local path keyed by its Run", () => {
  expect(agentRunVideoPath(AgentRunId.make("agentrun-one"))).toBe(
    "/agent-runs/agentrun-one/video"
  );
});
