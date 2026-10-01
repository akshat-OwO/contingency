import {
  AgentRunSummary,
  AgentTaskRunOutcome,
  TaskAgentRunState,
  TaskAgentRunSummary,
  TaskRunSessionSnapshot,
  TeachingCaptureState,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

import { taskRunSummary } from "../helpers/task-run.ts";

const decodeSummary = Schema.decodeUnknownSync(AgentRunSummary);
const decodeTask = Schema.decodeUnknownSync(TaskAgentRunSummary);

test("a composed task preserves redirection, findings, and skill-scoped inputs", () => {
  const decoded = decodeSummary(taskRunSummary);
  expect(decoded).toEqual(taskRunSummary);
  expect(Schema.encodeSync(AgentRunSummary)(decoded)).toEqual(taskRunSummary);
  expect(decoded).not.toHaveProperty("steps");
  expect(decoded).not.toHaveProperty("activeStepIndex");
  expect(decoded).not.toHaveProperty("coverage");
  expect(decoded).not.toHaveProperty("assessmentCounts");
});

test.each(AgentTaskRunOutcome.literals)(
  "%s never invents a task assessment for a skill-free Run",
  (outcome) => {
    const decoded = decodeTask({
      ...taskRunSummary,
      assessment: null,
      inputs: [],
      outcome,
      referencedSkills: [],
      variables: [],
    });
    expect(decoded.assessment).toBeNull();
    expect(decoded.outcome).toBe(outcome);
  }
);

test("a failed finding and assessment can coexist with a running lifecycle", () => {
  const run = Schema.decodeUnknownSync(TaskAgentRunState)({
    ...taskRunSummary,
    assessment: { ...taskRunSummary.assessment, outcome: "not-working" },
    lastAgentActivityAt: taskRunSummary.startedAt,
    lifecycle: { phase: "running" },
  });
  expect(run.lifecycle).toEqual({ phase: "running" });
  expect(run.findings[0]?.outcome).toBe("not-working");
  expect(run).not.toHaveProperty("activeStepIndex");
});

test("task reports require an explanation and browser evidence", () => {
  for (const assessment of [
    { ...taskRunSummary.assessment, evidence: [] },
    { ...taskRunSummary.assessment, explanation: "" },
    { ...taskRunSummary.assessment, evidence: [{ id: "", kind: "snapshot" }] },
  ]) {
    expect(() => decodeTask({ ...taskRunSummary, assessment })).toThrow();
  }
  expect(() =>
    decodeTask({
      ...taskRunSummary,
      findings: [{ ...taskRunSummary.findings[0], evidence: [] }],
    })
  ).toThrow();
});

test("input identities reject unknown skills, duplicates, and secret literals", () => {
  for (const inputs of [
    [{ flowSkillName: "unrequested", name: "product", value: "Mug" }],
    [taskRunSummary.inputs[0], taskRunSummary.inputs[0]],
    [{ flowSkillName: "browse-catalogue", name: "TOKEN", value: "secret" }],
  ]) {
    expect(() => decodeTask({ ...taskRunSummary, inputs })).toThrow();
  }
});

test("legacy timeout outcomes cannot be written as task executions", () => {
  expect(() =>
    decodeTask({ ...taskRunSummary, outcome: "timed-out" })
  ).toThrow();
  expect(() =>
    decodeSummary({ ...taskRunSummary, schemaVersion: 4 })
  ).toThrow();
});

test("a Dry Run task summary stays owned by its Teaching Recording", () => {
  const summary = decodeTask({
    ...taskRunSummary,
    purpose: {
      flowSkillName: "browse-catalogue",
      kind: "dry-run",
      recordingId: "recording-task",
      takeoverOccurred: true,
    },
  });
  const lifecycle = Schema.decodeUnknownSync(TeachingCaptureState)({
    _tag: "dry-run-failed",
    draftedAt: taskRunSummary.startedAt,
    dryRunEndedAt: taskRunSummary.endedAt,
    dryRunResult: {
      completedAt: taskRunSummary.endedAt,
      inputs: [],
      observableOutcome: "User Takeover prevents a passing Dry Run.",
      outcome: "failed",
    },
    dryRunSessionId: taskRunSummary.sessionId,
    dryRunStartedAt: taskRunSummary.startedAt,
    dryRunSummary: summary,
    readyAt: taskRunSummary.startedAt,
    skillPath: "browse-catalogue",
    startedAt: taskRunSummary.startedAt,
    stoppedAt: taskRunSummary.startedAt,
  });
  expect(lifecycle).toHaveProperty("dryRunSummary", summary);
});

test("task session contract exposes no singular skill or active-step requirement", () => {
  const schema = JSON.stringify(
    Schema.toJsonSchemaDocument(TaskRunSessionSnapshot)
  );
  expect(schema).toContain("requestedTask");
  expect(schema).not.toContain("activeStepIndex");
  expect(schema).not.toContain("coverage");
});
