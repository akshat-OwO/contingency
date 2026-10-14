import { FlowSkillName, OperationId } from "@contingency/protocol";
import { expect, test } from "vitest";

import { applyCommand, FIXTURE_SELECTION } from "@/prototypes/android/fixtures";
import { actionableNodes } from "@/prototypes/android/presentation";

test("offers only the taps the setup allowed", () => {
  const started = applyCommand(null, {
    _tag: "start",
    flowSkillName: FlowSkillName.make("checkout"),
    kind: "teaching",
    operationId: OperationId.make("prototype-start"),
    recordingId: null,
    selection: {
      ...FIXTURE_SELECTION,
      environment: {
        ...FIXTURE_SELECTION.environment,
        appId: "com.example.notes",
      },
      reversibleActions: [],
    },
  });
  expect(started?.requirements).toMatchObject({
    environment: { appId: "com.example.notes" },
    reversibleActions: [],
  });
  const prepared =
    started === null
      ? null
      : applyCommand(started, {
          _tag: "prepare",
          operationId: OperationId.make("prototype-prepare"),
          sessionId: started.id,
        });
  expect(prepared?.observation?.nodes.map((node) => node.name)).toContain(
    "Sign in"
  );
  expect(
    prepared === null ? [] : actionableNodes(prepared).map((node) => node.name)
  ).not.toContain("Sign in");
});
