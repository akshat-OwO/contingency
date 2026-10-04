import path from "node:path";

import { AgentRunTaskInput, OperationId } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { DemoSite } from "./demo-site.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { AgentRunFailure, startTaskRun } from "./mcp-agent-run.ts";
import {
  SessionStartResult,
  inStartView,
  sessionViewParameter,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import {
  EXAMPLE_FLOW_SKILL_NAMES,
  describeOnboardingExamples,
  findOnboardingExample,
  readExampleSkills,
} from "./onboarding-examples.ts";

/**
 * The onboarding surface: the bundled starter prompt, the demo store's
 * examples for this process, and the one tool that runs a bundled Example
 * Flow Skill (ADR 0050). Teaching, learning, Dry Runs, and verification keep
 * their ordinary tools; nothing here shortens them.
 */

export const STARTER_PROMPT_URI = "contingency://onboarding/starter-prompt";
export const EXAMPLES_URI = "contingency://onboarding/examples";

/** Built output keeps the prompt under `dist/onboarding`; a source checkout reads the package. */
export const resolveStarterPromptPath = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "onboarding", "starter-prompt.md")
    : path.resolve(moduleDirectory, "../../onboarding/starter-prompt.md");

export const starterPromptPath = resolveStarterPromptPath(import.meta.dirname);

const ExampleRunStartTool = Tool.make("agent_example_run_start", {
  dependencies: [AgentSession, FlowSkillCatalog, AgentRunStore, DemoSite],
  description:
    "Start a read-only demo Example in a clean context. Follow nextAction. Scope: demo host only. Not Teaching or verification. Inputs: contingency://onboarding/examples. Then use the ordinary Run tools.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    example: Schema.Literals(EXAMPLE_FLOW_SKILL_NAMES),
    inputs: Schema.Array(
      Schema.Struct({
        name: AgentRunTaskInput.fields.name,
        value: AgentRunTaskInput.fields.value,
      })
    ),
    operationId: OperationId,
    view: sessionViewParameter,
  }),
  success: SessionStartResult,
});

export const OnboardingTools = withStrictParameters(
  Toolkit.make(ExampleRunStartTool)
);

const exampleFailure = (cause: {
  readonly code: string;
  readonly message: string;
}) =>
  new AgentRunFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

export const OnboardingToolHandlersLive = OnboardingTools.toLayer({
  agent_example_run_start: ({ example, inputs, operationId, view }) =>
    Effect.gen(function* startExampleRun() {
      const demo = yield* DemoSite;
      const entry = findOnboardingExample(example);
      if (entry === undefined) {
        return yield* Effect.fail(
          exampleFailure({
            code: "flow_skill_invalid",
            message: `${example} is not a bundled Example Flow Skill.`,
          })
        );
      }
      const skills = yield* readExampleSkills([example]).pipe(
        Effect.mapError(exampleFailure)
      );
      return yield* startTaskRun(
        {
          clientName: "contingency-example",
          inputs: inputs.map((input) => ({
            ...input,
            flowSkillName: entry.flowSkillName,
          })),
          operationId,
          referencedSkills: [entry.flowSkillName],
          requestedTask: `Example: ${entry.title}`,
          url: `${demo.origin}${entry.startPath}`,
        },
        { origin: "example", skills }
      ).pipe(inStartView(view));
    }),
});

const readStarterPrompt = Effect.gen(function* readPrompt() {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(starterPromptPath).pipe(Effect.orDie);
});

export const McpOnboardingLayer = Layer.mergeAll(
  McpServer.toolkit(OnboardingTools).pipe(
    Layer.provide(OnboardingToolHandlersLive)
  ),
  McpServer.resource({
    audience: ["assistant"],
    content: readStarterPrompt,
    description:
      "The onboarding procedure for a session started with `contingency start`: prove the connection, show a bundled example, guide Teaching, learn, Dry Run, and record the user's verification.",
    mimeType: "text/markdown",
    name: "onboarding/starter-prompt",
    uri: STARTER_PROMPT_URI,
  }),
  McpServer.resource({
    audience: ["assistant"],
    content: Effect.gen(function* describeExamples() {
      const demo = yield* DemoSite;
      return describeOnboardingExamples(demo.origin);
    }),
    description:
      "The Ridgeline Hardware demo store's examples, with this process's demo origin, demo conditions, and how demo work is identified in the catalog.",
    mimeType: "text/markdown",
    name: "onboarding/examples",
    uri: EXAMPLES_URI,
  })
);
