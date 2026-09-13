import {
  AgentSessionSnapshot,
  TeachingCaptureState,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

const decodeState = Schema.decodeUnknownSync(TeachingCaptureState);
const decodeSession = Schema.decodeUnknownSync(AgentSessionSnapshot);
const decodeManifest = Schema.decodeUnknownSync(TeachingRecordingManifest);
const at = "2026-09-13T10:00:00.000Z";

const progressive = {
  draftedAt: at,
  dryRunEndedAt: at,
  dryRunStartedAt: at,
  readyAt: at,
  skillPath: "checkout-flow/SKILL.md",
  startedAt: at,
  stoppedAt: at,
  verifiedAt: at,
};

test("Teaching capture accepts every lifecycle state", () => {
  const states = [
    { _tag: "setup", requestedAt: at },
    { _tag: "recording", startedAt: at },
    { _tag: "finalizing", startedAt: at, stoppedAt: at },
    { _tag: "ready", readyAt: at, startedAt: at, stoppedAt: at },
    { _tag: "learning", readyAt: at, startedAt: at, stoppedAt: at },
    { _tag: "skill-drafted", ...progressive },
    { _tag: "dry-running", ...progressive },
    { _tag: "dry-run-passed", ...progressive },
    { _tag: "verified", ...progressive },
    { _tag: "failed", error: "Capture stopped", failedAt: at },
  ];

  expect(states.map((state) => decodeState(state)._tag)).toEqual([
    "setup",
    "recording",
    "finalizing",
    "ready",
    "learning",
    "skill-drafted",
    "dry-running",
    "dry-run-passed",
    "verified",
    "failed",
  ]);
});

test("Teaching capture rejects a state missing its required lifecycle data", () => {
  expect(() => decodeState({ _tag: "ready", startedAt: at })).toThrow();
  expect(() =>
    decodeState({ _tag: "verified", ...progressive, verifiedAt: "" })
  ).toThrow();
});

test("a completed cleanup requires a verified recording", () => {
  expect(() =>
    decodeManifest({
      artifacts: [],
      cleanup: { _tag: "completed", completedAt: at },
      createdAt: at,
      emulation: {
        permissions: [],
        userAgentProfile: "default",
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      flowSkillName: "checkout-flow",
      lifecycle: { _tag: "recording", startedAt: at },
      receipts: [],
      recordingId: "recording-checkout",
      schemaVersion: 1,
      updatedAt: at,
    })
  ).toThrow();
});

const sessionBase = {
  boundary: null,
  clientName: "integration-agent",
  clientVersion: "1.0.0",
  controller: "user",
  createdAt: at,
  currentUrl: "https://shop.example.test",
  decisionHistory: [],
  error: null,
  id: "agent-teaching",
  interruptedAction: null,
  ownerProcessId: "process-one",
  pendingDecisions: [],
  phase: "running",
  takeover: null,
  timeline: [],
  updatedAt: at,
  viewUrl: "http://127.0.0.1:7777/?session=agent-teaching",
};

test("session snapshots keep Teaching and Run state in separate variants", () => {
  const teaching = decodeSession({
    ...sessionBase,
    activity: "teaching",
    captureState: { _tag: "recording", startedAt: at },
    flowSkillName: "checkout-flow",
    recordingId: "recording-checkout",
    run: null,
    teaching: { actionCount: 2, draft: null, instructionCount: 1 },
    verification: null,
  });
  const run = decodeSession({
    ...sessionBase,
    activity: "run",
    captureState: null,
    controller: "agent",
    flowSkillName: null,
    recordingId: null,
    run: null,
    teaching: null,
    verification: null,
  });

  expect(teaching.recordingId).toBe("recording-checkout");
  expect(run.activity).toBe("run");
});

test("session snapshots reject mixed Teaching and Run data", () => {
  expect(() =>
    decodeSession({
      ...sessionBase,
      activity: "teaching",
      captureState: { _tag: "recording", startedAt: at },
      flowSkillName: "checkout-flow",
      recordingId: "recording-checkout",
      run: { title: "This must never coexist with Teaching" },
      teaching: { actionCount: 2, draft: null, instructionCount: 1 },
      verification: null,
    })
  ).toThrow();
  expect(() =>
    decodeSession({
      ...sessionBase,
      activity: "run",
      captureState: null,
      flowSkillName: null,
      recordingId: "recording-checkout",
      run: null,
      teaching: { actionCount: 2, draft: null, instructionCount: 1 },
      verification: null,
    })
  ).toThrow();
});
