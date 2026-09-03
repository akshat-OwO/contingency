import {
  AgentFlowDraftProposal,
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
