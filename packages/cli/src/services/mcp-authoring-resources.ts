import path from "node:path";

import { Effect, FileSystem, Layer } from "effect";
import { McpServer } from "effect/ai";

/** Writing guidance ships with the CLI and never reads host-installed skills. */
export const WRITING_RESOURCE_URI = "contingency://reference/writing";

/** Source checkouts and built bundles carry the same resource directory. */
export const resolveAuthoringResourceRoot = (
  moduleDirectory: string
): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "resources")
    : path.resolve(moduleDirectory, "../../resources");

const resourceRoot = resolveAuthoringResourceRoot(import.meta.dirname);

const readAuthoringResource = (file: "writing.md" | "learn-flow.md") =>
  Effect.gen(function* readPackagedReference() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readFileString(path.join(resourceRoot, file))
      .pipe(Effect.orDie);
  });

const LEARN_PROMPT_NAME = "learn-flow";

/**
 * The same procedure as a resource. Some clients never surface MCP prompts to
 * the model, and a user should not have to invoke one by hand, so both access
 * methods serve this one text.
 */
export const LEARN_FLOW_URI = "contingency://prompt/learn-flow";

/**
 * The reading order a learning agent follows. It is a prompt rather than a
 * sentence in a tool description because the host must be able to hand the
 * whole procedure to the agent in one call.
 */
const readLearnFlowResource = readAuthoringResource("learn-flow.md");

export const McpAuthoringResourcesLayer: Layer.Layer<
  never,
  never,
  FileSystem.FileSystem
> = Layer.mergeAll(
  McpServer.resource({
    audience: ["assistant"],
    content: readLearnFlowResource,
    description:
      "The learn-flow procedure: how to learn a Teaching Recording into a Flow Skill, Dry Run it, and record the user's verification. The same text as the learn-flow prompt.",
    mimeType: "text/markdown",
    name: LEARN_PROMPT_NAME,
    uri: LEARN_FLOW_URI,
  }),
  McpServer.prompt({
    content: () => readLearnFlowResource,
    description:
      "The reading order for learning a Contingency Teaching Recording into a Flow Skill, including the writing reference this server serves.",
    name: LEARN_PROMPT_NAME,
  }),
  McpServer.resource({
    audience: ["assistant"],
    content: readAuthoringResource("writing.md"),
    description:
      "Writing reference: technical document structure, clear and natural prose, and instructions agents can follow. Read before writing a Flow Skill.",
    mimeType: "text/markdown",
    name: "Writing",
    uri: WRITING_RESOURCE_URI,
  })
);
