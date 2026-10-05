import path from "node:path";

import { AgentRunTaskInput, OperationId } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { DemoSite } from "./demo-site.ts";
import type { DemoSiteService } from "./demo-site.ts";
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
 * The `contingency start` surface. Every server serves the work prompt, the
 * procedure for a session-only launch on the user's own website. A demo
 * server adds the onboarding starter prompt, the demo store's examples for
 * this process, and the one tool that runs a bundled Example Flow Skill
 * (ADR 0050). Teaching, learning, Dry Runs, and verification keep their
 * ordinary tools; nothing here shortens them.
 */

export const STARTER_PROMPT_URI = "contingency://onboarding/starter-prompt";
export const EXAMPLES_URI = "contingency://onboarding/examples";
export const WORK_PROMPT_URI = "contingency://start/work-prompt";

/** Built output keeps prompts under `dist/onboarding`; a source checkout reads the package. */
export const resolveOnboardingPromptPath = (
  moduleDirectory: string,
  file: string
): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "onboarding", file)
    : path.resolve(moduleDirectory, "../../onboarding", file);

export const starterPromptPath = resolveOnboardingPromptPath(
  import.meta.dirname,
  "starter-prompt.md"
);

export const workPromptPath = resolveOnboardingPromptPath(
  import.meta.dirname,
  "work-prompt.md"
);

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

const readPrompt = (promptPath: string) =>
  Effect.gen(function* readPromptFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(promptPath).pipe(Effect.orDie);
  });

export const McpWorkPromptLayer = McpServer.resource({
  audience: ["assistant"],
  content: readPrompt(workPromptPath),
  description:
    "The procedure for a session-only `contingency start` launch: prove the connection, check features with verified Flow Skills, guide Teaching on the user's website, learn, Dry Run, and record the user's verification.",
  mimeType: "text/markdown",
  name: "start/work-prompt",
  uri: WORK_PROMPT_URI,
});

/** The demo store's onboarding surface, served only by a demo server. */
export const McpOnboardingLayer = Layer.mergeAll(
  McpServer.toolkit(OnboardingTools).pipe(
    Layer.provide(OnboardingToolHandlersLive)
  ),
  McpServer.resource({
    audience: ["assistant"],
    content: readPrompt(starterPromptPath),
    description:
      "The onboarding procedure for a session started with `contingency start --demo`: prove the connection, show a bundled example, guide Teaching, learn, Dry Run, and record the user's verification.",
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

/**
 * The `start` surface for one server. A demo store, when supplied, adds the
 * onboarding prompt, examples, and Example tool; without one the server
 * neither binds the store nor offers its tools.
 */
export const makeMcpStartLayer = <R = never>(
  demoSite: Layer.Layer<DemoSiteService, never, R> | undefined
) =>
  demoSite === undefined
    ? McpWorkPromptLayer
    : Layer.mergeAll(
        McpWorkPromptLayer,
        McpOnboardingLayer.pipe(Layer.provide(demoSite))
      );
