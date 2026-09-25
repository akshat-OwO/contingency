import { makeBrowserRpcError } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  flowSkillDryRunPrompt,
  gestureFailureMessage,
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

  // `dry-run-failed` offered the same prompt-copying primary, so it loses it
  // on the same terms.
  const failed = teachingRecordingPresentation({
    _tag: "dry-run-failed",
    ...progressive,
    dryRunEndedAt: "2026-09-16T10:05:00.000Z",
    dryRunResult: {
      completedAt: "2026-09-16T10:05:00.000Z",
      inputs: [{ changed: true, name: "city", value: "Pune" }],
      observableOutcome: "The place order button was never found.",
      outcome: "failed" as const,
    },
    dryRunSessionId: "agent-dry-run",
    dryRunStartedAt: progressive.startedAt,
  });
  expect(failed.action).toBeNull();
  expect(failed.secondaries).toContain("copy-dry-run-prompt");
  expect(failed.secondaries).toContain("copy-failure");

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
  expect(prompt).toContain("agent_run_step_assess");
  expect(prompt).not.toContain("agent_flow_skill_dry_run_report");
  // The whole reason this is a hand-off rather than a button.
  expect(prompt).toContain("differs from the recorded journey");
});

test("names the lifecycle when a gesture lost the race to another process", () => {
  const message = gestureFailureMessage(
    "verify-flow",
    makeBrowserRpcError(
      "agent_session_conflict",
      "Teaching Recording recording-7 cannot be verified from verified."
    )
  );

  expect(message).toBe(
    "Verify flow no longer applies to this recording. Teaching Recording recording-7 cannot be verified from verified."
  );
});

test("names the gesture when the failure says nothing readable", () => {
  // The shape behind the rendered `[object Object]` in #211.
  expect(gestureFailureMessage("verify-flow", { message: { code: 17 } })).toBe(
    "The Workspace could not connect, so Verify flow did not reach the server."
  );
  expect(gestureFailureMessage("stop")).toBe(
    "The Workspace could not connect, so Stop did not reach the server."
  );
});

test("repeats a transport failure as the server told it", () => {
  expect(
    gestureFailureMessage("start", new Error("The Workspace lost the socket."))
  ).toBe("The Workspace lost the socket.");
});
