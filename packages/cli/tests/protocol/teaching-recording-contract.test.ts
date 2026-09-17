import {
  AgentSessionSnapshot,
  FlowSkillDiagnostic,
  FlowSkillSaveResult,
  TEACHING_TIMELINE_BUDGET_CHARACTERS,
  TeachingCaptureState,
  TeachingKeyframeContent,
  TeachingRecordingClaim,
  TeachingRecordingList,
  TeachingRecordingManifest,
  TeachingTimeline,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

const decodeState = Schema.decodeUnknownSync(TeachingCaptureState);
const decodeSession = Schema.decodeUnknownSync(AgentSessionSnapshot);
const decodeManifest = Schema.decodeUnknownSync(TeachingRecordingManifest);
const decodeClaim = Schema.decodeUnknownSync(TeachingRecordingClaim);
const decodeList = Schema.decodeUnknownSync(TeachingRecordingList);
const decodeTimeline = Schema.decodeUnknownSync(TeachingTimeline);
const decodeKeyframe = Schema.decodeUnknownSync(TeachingKeyframeContent);
const decodeSkillSave = Schema.decodeUnknownSync(FlowSkillSaveResult);
const decodeDiagnostic = Schema.decodeUnknownSync(FlowSkillDiagnostic);
const at = "2026-09-13T10:00:00.000Z";

const progressive = {
  draftedAt: at,
  dryRunEndedAt: at,
  dryRunResult: {
    completedAt: at,
    inputs: [{ changed: true, name: "city", value: "Pune" }],
    observableOutcome: "Delivery area is Pune.",
    outcome: "passed" as const,
  },
  dryRunSessionId: "agent-dry-run",
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
    {
      _tag: "learning",
      claim: { claimedAt: at, operationId: "claim-one", ownerPid: 123 },
      readyAt: at,
      startedAt: at,
      stoppedAt: at,
    },
    { _tag: "skill-drafted", ...progressive },
    {
      _tag: "dry-running",
      ...progressive,
      dryRunInputs: [{ changed: true, name: "city", value: "Pune" }],
    },
    {
      _tag: "dry-run-failed",
      ...progressive,
      dryRunResult: { ...progressive.dryRunResult, outcome: "failed" },
    },
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
    "dry-run-failed",
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

test("learning-agent contracts use recording ids and bounded references", () => {
  expect(
    decodeList({
      recordings: [
        {
          cleanup: { _tag: "pending" },
          failure: null,
          flowSkillName: "checkout-flow",
          lifecycle: "ready",
          recordingId: "recording-checkout",
          updatedAt: at,
        },
      ],
    }).recordings[0]?.recordingId
  ).toBe("recording-checkout");
  expect(
    decodeClaim({
      claimedAt: at,
      flowSkillName: "checkout-flow",
      operationId: "claim-checkout",
      recordingId: "recording-checkout",
    }).operationId
  ).toBe("claim-checkout");

  const timeline = decodeTimeline({
    entries: [
      {
        _tag: "keyframe",
        actionId: "action-checkout",
        at,
        hash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        id: "screenshot-checkout",
        seq: 1,
      },
    ],
    maxCharacters: TEACHING_TIMELINE_BUDGET_CHARACTERS,
    nextCursor: null,
    recordingId: "recording-checkout",
  });
  expect(timeline.entries[0]).not.toHaveProperty("path");
  expect(
    decodeKeyframe({
      format: "png",
      hash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      id: "screenshot-checkout",
      image: "cG5n",
      recordingId: "recording-checkout",
    }).format
  ).toBe("png");
  expect(
    decodeSkillSave({
      files: ["SKILL.md", "references/accessibility.md"],
      flowSkillName: "checkout-flow",
      recordingId: "recording-checkout",
    }).files
  ).toEqual(["SKILL.md", "references/accessibility.md"]);
});

test("a completed cleanup requires a verified recording", () => {
  expect(() =>
    decodeManifest({
      artifacts: [],
      cleanup: { _tag: "purged", completedAt: at },
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
      sessionId: "agent-teaching",
      updatedAt: at,
    })
  ).toThrow();
});

test("a Teaching Recording manifest requires the Agent Session that created it", () => {
  expect(() =>
    decodeManifest({
      artifacts: [],
      cleanup: { _tag: "pending" },
      createdAt: at,
      emulation: {
        permissions: [],
        userAgentProfile: "default",
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      flowSkillName: "checkout-flow",
      lifecycle: { _tag: "ready", readyAt: at, startedAt: at, stoppedAt: at },
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

test("a Flow Skill diagnostic names the file and field it belongs to", () => {
  const diagnostic = decodeDiagnostic({
    code: "flow_skill_name_mismatch",
    message:
      'SKILL.md declares name "other" but the package is saved as "checkout-flow".',
    path: ["SKILL.md", "frontmatter", "name"],
  });

  expect(diagnostic.path[0]).toBe("SKILL.md");
  // The path is a file route, not a JSON pointer into an Agent Flow draft, so
  // an index would tell the agent nothing about which line to fix.
  expect(() =>
    decodeDiagnostic({
      code: "flow_skill_name_mismatch",
      message: "The name is wrong.",
      path: ["SKILL.md", 0],
    })
  ).toThrow();
  expect(() =>
    decodeDiagnostic({
      code: "flow_skill_name_mismatch",
      message: "",
      path: ["SKILL.md"],
    })
  ).toThrow();
});
