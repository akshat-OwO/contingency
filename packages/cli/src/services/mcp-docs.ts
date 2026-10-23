import path from "node:path";

import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

/**
 * The documentation topics that ship in the package (ADR 0063). A developer
 * reads them on npm or GitHub; an agent reads the same files as MCP resources
 * or through the `docs_get` operation, so there is one source for both.
 */

export const DOCS_URI_PREFIX = "contingency://docs/";

export const DOC_TOPICS = [
  {
    description:
      "System One and Nev: how the user installs a Local System One with contingency system-one setup, endpoint precedence, startup, updates, rollback, and removal.",
    title: "System One",
    topic: "system-one",
  },
  {
    description:
      "Every Setting: config.json locations, precedence, each key with its environment variable, type, and default, and the environment-only Settings.",
    title: "Settings",
    topic: "settings",
  },
  {
    description:
      "What Contingency can and can't do: Platform Runtimes and the Support Matrix, Teaching, Guided Run, Dry Run, Interactive Run, Scan Requirements, Browser Checks, Emulation, and the Execution Boundary.",
    title: "Capabilities",
    topic: "capabilities",
  },
  {
    description:
      "Variables: declaring Flow Skill inputs, what secret and runtime mean, and how values are supplied.",
    title: "Variables",
    topic: "variables",
  },
  {
    description:
      "Fixed limits: sessions, Teaching Recordings, browser observation, and agent_code_execute programs.",
    title: "Limits",
    topic: "limits",
  },
] as const;

export type DocTopic = (typeof DOC_TOPICS)[number]["topic"];

export const docUri = (topic: DocTopic) => `${DOCS_URI_PREFIX}${topic}`;

/**
 * Built output keeps the topics under `dist/docs`; a source checkout reads
 * the package directory, so tests need no build.
 */
export const resolveDocsRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "docs")
    : path.resolve(moduleDirectory, "../../docs");

const docsRoot = resolveDocsRoot(import.meta.dirname);

export const readDocTopic = (
  topic: DocTopic,
  root: string = docsRoot
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* readDocTopicEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    // A missing topic is a broken package, not a caller error.
    return yield* fileSystem
      .readFileString(path.join(root, `${topic}.md`))
      .pipe(Effect.orDie);
  });

export const McpDocsResourcesLayer: Layer.Layer<
  never,
  never,
  FileSystem.FileSystem
> = Layer.mergeAll(
  Layer.empty,
  ...DOC_TOPICS.map((entry) =>
    McpServer.resource({
      audience: ["assistant", "user"],
      content: readDocTopic(entry.topic),
      description: entry.description,
      mimeType: "text/markdown",
      name: `docs/${entry.topic}`,
      uri: docUri(entry.topic),
    })
  )
);

const DocsGetTool = readOnly(
  Tool.make("docs_get", {
    dependencies: [FileSystem.FileSystem],
    description: `Read one Contingency documentation topic as markdown. Topics: ${DOC_TOPICS.map(
      ({ description, topic }) => `${topic} (${description})`
    ).join(
      " "
    )} The same text is the MCP resource contingency://docs/<topic>. Configuration is read from the config.json files the settings topic names; no tool reports it.`,
    parameters: Schema.Struct({
      topic: Schema.Literals(DOC_TOPICS.map(({ topic }) => topic)),
    }),
    success: Schema.Struct({
      markdown: Schema.String,
      title: Schema.String,
      topic: Schema.String,
      uri: Schema.String,
    }),
  })
);

export const DocsTools = withStrictParameters(Toolkit.make(DocsGetTool));

export const DocsToolHandlersLive = DocsTools.toLayer({
  docs_get: ({ topic }) =>
    readDocTopic(topic).pipe(
      Effect.map((markdown) => ({
        markdown,
        title:
          DOC_TOPICS.find((entry) => entry.topic === topic)?.title ?? topic,
        topic,
        uri: docUri(topic),
      }))
    ),
});
