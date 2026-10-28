import {
  AgentElementRef,
  AgentRunTaskInput,
  AgentSnapshotId,
  FlowSkillName,
  TeachingVariableInput,
  UserAgentProfileId,
  Variable,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  readFlowSkillFrontmatter,
  stampFlowSkillProvenance,
} from "../../src/services/flow-skill-package.ts";
import {
  taskVariables,
  validateTaskInputs,
} from "../../src/services/requested-flow-skills.ts";
import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";
import { teachingEventsFor } from "../../src/services/teaching-recorder.ts";
import { parameterizeVariables } from "../../src/services/teaching-recording-learning.ts";

it("accepts and drops legacy secret keys even with strict excess-property checks", () => {
  const declaration = { name: "PASSWORD", runtime: true, secret: true };
  const decoded = Schema.decodeUnknownSync(Variable, {
    onExcessProperty: "error",
  })(declaration);
  expect(decoded).toEqual({ name: "PASSWORD", runtime: true });
  expect(Schema.encodeSync(Variable)(declaration)).toEqual(decoded);
  expect(
    Schema.decodeUnknownSync(AgentRunTaskInput, { onExcessProperty: "error" })({
      flowSkillName: "login",
      name: "PASSWORD",
      secret: true,
      value: "test-password",
    })
  ).toEqual({
    flowSkillName: "login",
    name: "PASSWORD",
    value: "test-password",
  });
  const request = Schema.decodeUnknownSync(TeachingVariableInput, {
    onExcessProperty: "error",
  })({
    operationId: "legacy-secret",
    sessionId: "agent-legacy",
    value: "test-password",
    variable: declaration,
  });
  expect(request.variable).toEqual(decoded);
  expect(
    Schema.encodeSync(TeachingVariableInput)(request).variable
  ).not.toHaveProperty("secret");
});

it("shows the Teaching literal and writes its reference into every learned file", () => {
  const at = "2026-10-28T00:00:00.000Z";
  const url = "https://shop.test/login?password=test-password#test-password";
  const capture = makeDemonstrationCapture(url);
  capture.recordVariable(
    { name: "PASSWORD", runtime: true, secret: true },
    "test-password",
    "#password"
  );
  capture.recordAction({
    action: {
      ref: AgentElementRef.make("e1"),
      text: "test-password",
      type: "fill",
    },
    actor: "user",
    at,
    description: "Enter test-password",
    id: "password-fill",
    outcome: "completed",
    snapshotAfter: {
      capturedAt: at,
      nodes: [
        {
          depth: 0,
          name: "Password",
          ref: AgentElementRef.make("e1"),
          role: "textbox",
          value: "test-password",
        },
      ],
      snapshotId: AgentSnapshotId.make("snapshot-password"),
      title: "Test login",
      url,
    },
    snapshotBefore: null,
    urlAfter: url,
    urlBefore: url,
  });
  const events = teachingEventsFor(
    capture.current(),
    {
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("default"),
      viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
    },
    at,
    at,
    "user"
  );
  const action = events.find((event) => event._tag === "action");
  expect(action?.variableName).toBe("PASSWORD");
  expect(action?.target?.value).toBe("test-password");
  expect(action?.target?.valueWithheld).toBe(false);
  expect(action?.after.url).toBe(
    "https://shop.test/login?password=%5Bsensitive%5D"
  );
  expect(capture.current().variables).toEqual([
    { name: "PASSWORD", runtime: true },
  ]);
  if (action === undefined || action.target === null) {
    throw new Error("Missing Variable action");
  }
  const overlapping = parameterizeVariables(
    [
      {
        content: "test-password {{PASSWORD}} PASSWORD",
        path: "references/overlap.md",
      },
    ],
    [
      ...events,
      {
        ...action,
        target: { ...action.target, value: "PASSWORD" },
        variableName: "OTHER",
      },
    ]
  );
  expect(overlapping[0]?.content).toBe("{{PASSWORD}} {{PASSWORD}} {{OTHER}}");
  const bounded = parameterizeVariables(
    [{ content: "1. Sign in as admin, not administrator.", path: "SKILL.md" }],
    [
      {
        ...action,
        target: { ...action.target, value: "1" },
        variableName: "PIN",
      },
      {
        ...action,
        target: { ...action.target, value: "admin" },
        variableName: "USER",
      },
    ]
  );
  expect(bounded[0]?.content).toBe(
    "1. Sign in as {{USER}}, not administrator."
  );
  const content =
    "---\nname: login\ndescription: Test login.\ninputs:\n  - name: PASSWORD\n    secret: true\n---\n\n1. Enter test-password. Done when: signed in.\n";
  const files = parameterizeVariables(
    [
      { content, path: "SKILL.md" },
      { content: "Use test-password", path: "references/login.md" },
    ],
    events
  );
  expect(JSON.stringify(files)).not.toContain("test-password");
  expect(files[1]?.content).toBe("Use {{PASSWORD}}");
  const stamped = stampFlowSkillProvenance(files[0]?.content ?? "", {
    emulation: null,
    hosts: ["shop.test"],
  });
  expect(stamped).not.toContain("secret:");
  expect(readFlowSkillFrontmatter(stamped)?.inputs).toEqual([
    { description: undefined, name: "PASSWORD" },
  ]);
});

it.effect(
  "accepts supplied inputs and on-demand Variables regardless of case",
  () =>
    Effect.gen(function* caseIndependentInputs() {
      const skill = {
        directory: "/catalog/login",
        emulation: undefined,
        files: [],
        hosts: [],
        inputs: [
          { description: undefined, name: "PASSWORD" },
          { description: undefined, name: "password" },
        ],
        name: FlowSkillName.make("login"),
        steps: [],
        title: "login",
      };
      yield* validateTaskInputs(
        [skill],
        [
          {
            flowSkillName: skill.name,
            name: "PASSWORD",
            value: "visible-test-value",
          },
        ]
      );
      expect(
        taskVariables(skill).map(({ name, ...variable }) => ({
          ...variable,
          name: name.toLowerCase(),
        }))
      ).toEqual([
        {
          flowSkillName: "login",
          name: "password",
          runtime: true,
          supplied: false,
        },
        {
          flowSkillName: "login",
          name: "password",
          runtime: true,
          supplied: false,
        },
      ]);
    })
);
