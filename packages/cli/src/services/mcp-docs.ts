import path from "node:path";

import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { DOC_TOPICS, docUri } from "./doc-topics.ts";
import type { DocTopic } from "./doc-topics.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

export {
  DOC_TOPICS,
  DOCS_URI_PREFIX,
  docUri,
  type DocTopic,
} from "./doc-topics.ts";

/**
 * The one document every agent reads before acting, whatever launched it; the
 * workflow guides after it are read only when their work begins (ADR 0069).
 */
export const GETTING_STARTED_URI = docUri("getting-started");

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

/**
 * This server's own text for the getting-started guide: a session launched
 * by `contingency start` appends its launch facts and procedure (ADR 0069).
 */
export type SessionGuide = Effect.Effect<string, never, FileSystem.FileSystem>;

/** The topic as this server serves it; only getting-started varies. */
const readServedTopic = (topic: DocTopic, session?: SessionGuide) =>
  topic === "getting-started" && session !== undefined
    ? Effect.all([readDocTopic(topic), session]).pipe(
        Effect.map(([base, appended]) => `${base.trimEnd()}\n\n${appended}`)
      )
    : readDocTopic(topic);

export const makeMcpDocsResourcesLayer = (
  session?: SessionGuide
): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.mergeAll(
    Layer.empty,
    ...DOC_TOPICS.map((entry) =>
      McpServer.resource({
        audience: ["assistant", "user"],
        content: readServedTopic(entry.topic, session),
        description: entry.description,
        mimeType: "text/markdown",
        name: `docs/${entry.topic}`,
        uri: docUri(entry.topic),
      })
    )
  );

export const McpDocsResourcesLayer = makeMcpDocsResourcesLayer();

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

export const makeDocsToolHandlers = (session?: SessionGuide) =>
  DocsTools.toLayer({
    docs_get: ({ topic }) =>
      readServedTopic(topic, session).pipe(
        Effect.map((markdown) => ({
          markdown,
          title:
            DOC_TOPICS.find((entry) => entry.topic === topic)?.title ?? topic,
          topic,
          uri: docUri(topic),
        }))
      ),
  });

export const DocsToolHandlersLive = makeDocsToolHandlers();
