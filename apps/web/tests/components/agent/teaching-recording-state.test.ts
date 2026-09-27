import { makeBrowserRpcError } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  gestureFailureMessage,
  teachingRecordingPresentation,
} from "@/components/agent/teaching-recording-state";

test("offers the settled Dry Run, verification, and cleanup actions", () => {
  const progressive = {
    draftedAt: "2026-09-16T10:00:00.000Z",
    readyAt: "2026-09-16T10:00:00.000Z",
    skillPath: "set-delivery-area/SKILL.md",
    startedAt: "2026-09-16T10:00:00.000Z",
    stoppedAt: "2026-09-16T10:00:00.000Z",
  };
  // A Dry Run needs inputs the dock cannot collect, so `skill-drafted` leaves
  // it to the user's agent instead of a button that starts nothing.
  const drafted = teachingRecordingPresentation({
    _tag: "skill-drafted",
    ...progressive,
  });
  expect(drafted.action).toBeNull();
  expect(drafted.secondaries).toStrictEqual([]);

  // `dry-run-failed` offers no action of its own either; its explanation is
  // the next step the dock keeps behind its details button (#297).
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
  expect(failed.secondaries).toStrictEqual([]);
  expect(failed.nextStep).toBe("The place order button was never found.");

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

test("offers Start only once the agent hands Teaching setup to the user", () => {
  const setup = {
    _tag: "setup",
    requestedAt: "2026-09-16T10:00:00.000Z",
  } as const;

  // An agent-opened session is being prepared: Start is absent, not
  // disabled, until the handoff (ADR 0042).
  const preparing = teachingRecordingPresentation(setup, undefined, "agent");
  expect(preparing.action).toBeNull();
  expect(preparing.badge).toBe("Agent preparing");
  expect(preparing.nextStep).toContain("hands you control");

  const handedOff = teachingRecordingPresentation(setup, undefined, "user");
  expect(handedOff.action?.gesture).toBe("start");
  expect(handedOff.badge).toBe("Not recording");
});

test("offers nothing once a session ends before recording started", () => {
  const ended = teachingRecordingPresentation(
    { _tag: "setup", requestedAt: "2026-09-16T10:00:00.000Z" },
    undefined,
    "user",
    "closed"
  );
  expect(ended.action).toBeNull();
  expect(ended.secondaries).toEqual([]);
  expect(ended.badge).toBe("Not recorded");
});
