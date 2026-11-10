import path from "node:path";

import { AgentRunTaskInput, OperationId } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { DemoSite } from "./demo-site.ts";
import type { DemoSiteService } from "./demo-site.ts";
import { FlowCatalog } from "./flow-catalog.ts";
import { AgentRunFailure, startTaskRun } from "./mcp-agent-run.ts";
import {
  SessionStartResult,
  inStartView,
  sessionViewParameter,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import {
  EXAMPLE_FLOW_FLOW_NAMES,
  describeOnboardingExamples,
  findOnboardingExample,
  readExampleFlows,
} from "./onboarding-examples.ts";

/**
 * The `contingency start` surface. A session launched by `start` appends its
 * launch facts and procedure to getting-started: the work procedure for the
 * user's own website, or the onboarding procedure with `--demo` (ADR 0069).
 * A demo server adds the demo store's examples for this process and the one
 * tool that runs a bundled Example Flow (ADR 0050). Teaching, learning, Dry
 * Runs, and verification keep their ordinary tools; nothing here shortens
 * them.
 */

export const EXAMPLES_URI = "contingency://onboarding/examples";

/** The heading getting-started gains in a session `start` launched. */
export const SESSION_GUIDE_HEADING = "## This session";

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
  dependencies: [AgentSession, FlowCatalog, AgentRunStore, DemoSite],
  description:
    "Start a read-only demo Example in a clean context. Follow nextAction. Scope: demo host only. Not Teaching or verification. Inputs: contingency://onboarding/examples. Then use the ordinary Run tools.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    example: Schema.Literals(EXAMPLE_FLOW_FLOW_NAMES),
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
            code: "flow_invalid",
            message: `${example} is not a bundled Example Flow.`,
          })
        );
      }
      const flows = yield* readExampleFlows([example]).pipe(
        Effect.mapError(exampleFailure)
      );
      return yield* startTaskRun(
        {
          clientName: "contingency-example",
          inputs: inputs.map((input) => ({
            ...input,
            flowName: entry.flowName,
          })),
          operationId,
          referencedFlows: [entry.flowName],
          requestedTask: `Example: ${entry.title}`,
          url: `${demo.origin}${entry.startPath}`,
        },
        { flows, origin: "example" }
      ).pipe(inStartView(view));
    }),
});

const readProcedure = (promptPath: string) =>
  Effect.gen(function* readProcedureFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(promptPath).pipe(Effect.orDie);
  });

/**
 * The section a `start` session appends to getting-started: its launch facts,
 * then the demo onboarding procedure or the work procedure.
 */
export const makeSessionGuide = (options: {
  readonly demo: boolean;
  readonly launchContext?: string | undefined;
}) =>
  readProcedure(options.demo ? starterPromptPath : workPromptPath).pipe(
    Effect.map((procedure) =>
      [SESSION_GUIDE_HEADING, options.launchContext, procedure.trimEnd()]
        .filter((part) => part !== undefined)
        .join("\n\n")
    )
  );

/**
 * The demo store's examples, served only by a demo server. The single-tool
 * interface serves them without the Example tool, whose operation it offers
 * inside programs instead (ADR 0059).
 */
export const makeMcpStartLayer = <R = never>(
  demoSite: Layer.Layer<DemoSiteService, never, R> | undefined
) =>
  demoSite === undefined
    ? Layer.empty
    : McpServer.resource({
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
      }).pipe(Layer.provide(demoSite));
