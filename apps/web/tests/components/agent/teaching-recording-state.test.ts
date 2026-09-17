import { expect, test } from "vitest";

import {
  teachingAgentPrompt,
  teachingRecordingPresentation,
} from "@/components/agent/teaching-recording-state";

test("points the learning agent at Contingency's own authoring skills", () => {
  const prompt = teachingAgentPrompt("set-delivery-area", "recording-7");

  expect(prompt).toContain("recording-7");
  expect(prompt).toContain('"set-delivery-area"');
  for (const uri of [
    "contingency://skill/writing-for-agents",
    "contingency://skill/writing-for-agents/SKILL-MECHANICS.md",
    "contingency://skill/technical-writing",
    "contingency://skill/unslop",
  ]) {
    expect(prompt).toContain(uri);
  }
  // Availability is Contingency's job, so the prompt does not hedge, and it
  // never sends the agent to the skill it must not use.
  expect(prompt).not.toContain("if available");
  expect(prompt).toContain("Do not use skill-creator");
});

test("offers the settled Dry Run, verification, and cleanup actions", () => {
  const progressive = {
    draftedAt: "2026-09-16T10:00:00.000Z",
    readyAt: "2026-09-16T10:00:00.000Z",
    skillPath: "set-delivery-area/SKILL.md",
    startedAt: "2026-09-16T10:00:00.000Z",
    stoppedAt: "2026-09-16T10:00:00.000Z",
  };
  expect(
    teachingRecordingPresentation({ _tag: "skill-drafted", ...progressive })
      .action?.label
  ).toBe("Dry run");

  const result = {
    completedAt: "2026-09-16T10:05:00.000Z",
    inputs: [{ changed: true, name: "city", value: "Pune" }],
    observableOutcome: "Delivering to Baner, Pune.",
    outcome: "passed" as const,
  };
  const passed = teachingRecordingPresentation({
    _tag: "dry-run-passed",
    ...progressive,
    dryRunEndedAt: result.completedAt,
    dryRunResult: result,
    dryRunSessionId: "agent-dry-run",
    dryRunStartedAt: progressive.startedAt,
  });
  expect(passed.action?.label).toBe("Verify flow");
  expect(passed.secondaries).toContain("reject-flow");

  const cleanupFailure = teachingRecordingPresentation(
    {
      _tag: "verified",
      ...progressive,
      dryRunEndedAt: result.completedAt,
      dryRunResult: result,
      dryRunSessionId: "agent-dry-run",
      dryRunStartedAt: progressive.startedAt,
      verifiedAt: result.completedAt,
    },
    {
      _tag: "purge-pending",
      failure: "Permission denied",
      retainedFiles: ["recording.webm", "trace.zip"],
    }
  );
  expect(cleanupFailure.action?.label).toBe("Retry cleanup");
  expect(cleanupFailure.nextStep).toContain("recording.webm");

  const verified = {
    _tag: "verified" as const,
    ...progressive,
    dryRunEndedAt: result.completedAt,
    dryRunResult: result,
    dryRunSessionId: "agent-dry-run",
    dryRunStartedAt: progressive.startedAt,
    verifiedAt: result.completedAt,
  };
  expect(
    teachingRecordingPresentation(verified, {
      _tag: "purge-pending",
      failure: null,
      retainedFiles: ["recording.webm"],
    }).badge
  ).toBe("Deleting recording");
  expect(
    teachingRecordingPresentation(verified, {
      _tag: "purged",
      completedAt: result.completedAt,
    }).badge
  ).toBe("Recording deleted");
});
