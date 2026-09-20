import type { AgentSessionSnapshot } from "@contingency/protocol";
import { AgentSessionId } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  adoptSessionSnapshot,
  agentSessionActivityLabel,
  agentSessionLabel,
} from "@/components/agent/agent-workspace-state";

type TeachingSnapshot = Extract<
  AgentSessionSnapshot,
  { readonly activity: "teaching" }
>;

/** One Teaching session, at the lifecycle and the revision a test needs. */
const teaching = (
  updatedAt: string,
  captureState: TeachingSnapshot["captureState"]
): AgentSessionSnapshot =>
  ({
    activity: "teaching",
    captureState,
    clientName: "Test agent",
    clientVersion: "1.0",
    controller: "user",
    createdAt: "2026-09-18T00:00:00.000Z",
    currentUrl: "https://example.com/",
    flowSkillName: "add-anvil",
    id: "agent-one",
    interruptedAction: null,
    ownerProcessId: "mcp-test",
    phase: "running",
    recordingId: "recording-39cd",
    run: null,
    takeover: null,
    teaching: { actionCount: 4, instructionCount: 0 },
    timeline: [],
    updatedAt,
    verification: null,
    viewUrl: "http://127.0.0.1:7777/?session=agent-one",
  }) satisfies TeachingSnapshot;

const dryRunPassed = {
  _tag: "dry-run-passed",
  draftedAt: "2026-09-18T00:00:05.000Z",
  dryRunResult: {
    observableOutcome: "The anvil is in the cart.",
    passed: true,
    reportedAt: "2026-09-18T00:00:08.000Z",
  },
  dryRunStartedAt: "2026-09-18T00:00:06.000Z",
  readyAt: "2026-09-18T00:00:04.000Z",
  skillPath: "add-anvil/SKILL.md",
  startedAt: "2026-09-18T00:00:01.000Z",
  stoppedAt: "2026-09-18T00:00:03.000Z",
} satisfies TeachingSnapshot["captureState"];

const verified = {
  _tag: "verified",
  draftedAt: "2026-09-18T00:00:05.000Z",
  readyAt: "2026-09-18T00:00:04.000Z",
  skillPath: "add-anvil/SKILL.md",
  startedAt: "2026-09-18T00:00:01.000Z",
  stoppedAt: "2026-09-18T00:00:03.000Z",
  verifiedAt: "2026-09-18T00:00:10.000Z",
} satisfies TeachingSnapshot["captureState"];

test("adopts a newer lifecycle another process moved the recording to", () => {
  const held = teaching("2026-09-18T00:00:08.000Z", dryRunPassed);
  const polled = teaching("2026-09-18T00:00:10.000Z", verified);

  expect(adoptSessionSnapshot(held, polled)).toBe(polled);
});

test("keeps a held snapshot the poll has not caught up with", () => {
  const held = teaching("2026-09-18T00:00:10.000Z", verified);
  const polled = teaching("2026-09-18T00:00:08.000Z", dryRunPassed);

  expect(adoptSessionSnapshot(held, polled)).toBe(held);
  expect(adoptSessionSnapshot(held, held)).toBe(held);
});

test("takes the polled snapshot when there is nothing held", () => {
  const polled = teaching("2026-09-18T00:00:10.000Z", verified);

  expect(adoptSessionSnapshot(undefined, polled)).toBe(polled);
});

test("takes the polled snapshot when the selection changed", () => {
  const held = {
    ...teaching("2026-09-19T00:00:00.000Z", verified),
    id: AgentSessionId.make("agent-two"),
  };
  const polled = teaching("2026-09-18T00:00:10.000Z", verified);

  expect(adoptSessionSnapshot(held, polled)).toBe(polled);
});

type RunSnapshot = Extract<AgentSessionSnapshot, { readonly activity: "run" }>;

/** One run session, either a Dry Run rehearsal or an Interactive Run. */
const run = (dryRun: RunSnapshot["dryRun"]): RunSnapshot =>
  ({
    activity: "run",
    captureState: null,
    clientName: "Test agent",
    clientVersion: "1.0",
    controller: "agent",
    createdAt: "2026-09-18T00:00:00.000Z",
    currentUrl: "https://example.com/",
    dryRun,
    flowSkillName: dryRun === null ? null : dryRun.flowSkillName,
    id: AgentSessionId.make("agent-run"),
    interruptedAction: null,
    ownerProcessId: "mcp-test",
    phase: "running",
    recordingId: dryRun === null ? null : dryRun.recordingId,
    run: null,
    takeover: null,
    teaching: null,
    timeline: [],
    updatedAt: "2026-09-18T00:00:00.000Z",
    viewUrl: "http://127.0.0.1:7777/?session=agent-run",
  }) satisfies RunSnapshot;

test("labels a Dry Run with the Flow Skill it rehearses", () => {
  const rehearsal = run({
    flowSkillName: "add-anvil",
    recordingId: "recording-39cd",
    startedAt: "2026-09-18T00:00:06.000Z",
  });

  expect(agentSessionLabel(rehearsal)).toBe("add-anvil · Dry Run");
  expect(agentSessionActivityLabel(rehearsal)).toBe("Dry Run");
});

test("labels an Interactive Run without its raw session id", () => {
  expect(agentSessionActivityLabel(run(null))).toBe("Interactive Run");
  expect(agentSessionLabel(run(null))).toBe("Test agent · Interactive Run");
  expect(agentSessionLabel(run(null))).not.toContain("agent-run");
});
