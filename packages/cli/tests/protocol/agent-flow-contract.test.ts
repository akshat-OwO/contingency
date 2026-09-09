import {
  AgentFlowDraftProposal,
  AgentFlowDraftSave,
  AgentPendingDecision,
  AgentPendingDecisionResolution,
  AgentTimelineEntry,
  TeachingFeed,
  TeachingVariableInput,
} from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

const decodeVariableInput = Schema.decodeUnknownSync(TeachingVariableInput);

test("private Teaching input decodes every secret and runtime combination", () => {
  for (const secret of [false, true]) {
    for (const runtime of [false, true]) {
      expect(
        decodeVariableInput({
          operationId: "private-input",
          ref: "e1",
          sessionId: "agent-teaching",
          value: "private literal",
          variable: { name: "ACCOUNT", runtime, secret },
        }).variable
      ).toEqual({ name: "ACCOUNT", runtime, secret });
    }
  }
});

test("Teaching contracts carry Variable declarations without literal values", () => {
  const feedSchema = JSON.stringify(Schema.toJsonSchemaDocument(TeachingFeed));
  const draftSchema = JSON.stringify(
    Schema.toJsonSchemaDocument(AgentFlowDraftProposal)
  );
  expect(feedSchema).toContain("variables");
  expect(feedSchema).not.toContain("cookies");
  expect(feedSchema).not.toContain("authorizationHeaders");
  expect(feedSchema).not.toContain("networkBodies");
  expect(feedSchema).not.toContain("trace");
  expect(feedSchema).not.toContain("video");
  expect(draftSchema).toContain("secret");
  expect(draftSchema).toContain("runtime");
});

test("a draft save mints a new identity for null and for an omitted id", () => {
  const draft = {
    description: "Search the catalog",
    domainScope: { hosts: ["example.com"] },
    schemaVersion: 1,
    steps: [
      {
        confirmation: false,
        description: "Search for a product",
        firstActionId: "a1",
        lastActionId: "a2",
        name: "Search",
      },
    ],
    tags: null,
    title: "Search",
    variables: null,
  };
  const base = {
    basedOnRevisionId: null,
    draft,
    operationId: "op-1",
    sessionId: "agent-teaching",
  };
  const decode = Schema.decodeUnknownSync(AgentFlowDraftSave);
  expect(decode({ ...base, agentFlowId: null }).agentFlowId).toBeUndefined();
  expect(decode(base).agentFlowId).toBeUndefined();
});

test("an optional field with an explicit undefined encodes as an absent key", () => {
  const entry = Schema.encodeUnknownSync(AgentTimelineEntry)({
    actor: "agent",
    at: "2026-09-06T00:00:00.000Z",
    description: "Failed action",
    detail: undefined,
    dispatched: true,
    id: "entry-1",
    outcome: "failed",
  });
  expect("detail" in entry).toBe(false);
});

test("a decision written before boundary decisions existed still decodes", () => {
  const pending = Schema.decodeUnknownSync(AgentPendingDecision)({
    agentFlowId: "flow-shop",
    createdAt: "2026-09-08T00:00:00.000Z",
    kind: "approve_flow",
    pendingDecisionId: "pending-1",
    revisionId: "rev-1",
    scopeSummary: "Approve the verified draft.",
    sessionId: null,
  });
  expect(pending.boundaryId).toBeNull();
  const resolution = Schema.decodeUnknownSync(AgentPendingDecisionResolution)({
    agentFlowId: "flow-shop",
    decidedAt: "2026-09-08T00:00:01.000Z",
    decision: "approve",
    kind: "approve_flow",
    operationId: "approve-1",
    pendingDecisionId: "pending-1",
    revisionId: "rev-1",
  });
  expect(resolution.boundaryId).toBeNull();
});
