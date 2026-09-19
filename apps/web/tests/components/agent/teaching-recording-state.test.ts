import { expect, test } from "vitest";

import {
  flowSkillDryRunPrompt,
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
  // A Dry Run needs inputs the dock cannot collect, so `skill-drafted` offers
  // the hand-off by name instead of a primary button that starts nothing.
  const drafted = teachingRecordingPresentation({
    _tag: "skill-drafted",
    ...progressive,
  });
  expect(drafted.action).toBeNull();
  expect(drafted.secondaries).toContain("copy-dry-run-prompt");

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
  expect(passed.action?.gesture).toBe("verify-flow");
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

test("hands the dry run to an agent with the inputs it must change", () => {
  const prompt = flowSkillDryRunPrompt("add-anvil", "recording-7");

  expect(prompt).toContain('"add-anvil"');
  expect(prompt).toContain("recording-7");
  expect(prompt).toContain("agent_flow_skill_dry_run_start");
  expect(prompt).toContain("agent_flow_skill_dry_run_report");
  // The whole reason this is a hand-off rather than a button.
  expect(prompt).toContain("differs from the recorded journey");
});
