import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import {
  DOC_TOPICS,
  docUri,
  resolveDocsRoot,
} from "../../src/services/mcp-docs.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

// One hang guard per test, sized for a hung process rather than the work.
const HANG_GUARD_MS = 60_000;

const docsRoot = path.resolve(import.meta.dirname, "../../docs");

const ResourceList = Schema.Struct({
  result: Schema.Struct({
    resources: Schema.Array(
      Schema.Struct({
        mimeType: Schema.optional(Schema.String),
        uri: Schema.String,
      })
    ),
  }),
});

const ResourceRead = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
});

const Execution = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});

const live = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.scoped,
    Effect.timeout(HANG_GUARD_MS),
    Effect.provide(NodeServices.layer)
  );

const readTopic = (topic: string) =>
  Effect.gen(function* readTopicFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(path.join(docsRoot, `${topic}.md`));
  });

it("finds the topics beside the bundle and in a source checkout", () => {
  expect(resolveDocsRoot("/pkg/dist")).toBe("/pkg/dist/docs");
  expect(resolveDocsRoot("/pkg/src/services")).toBe("/pkg/docs");
});

for (const mcpInterface of ["native", "single-tool"] as const) {
  it.live(
    `serves every topic as a resource on the ${mcpInterface} interface`,
    () =>
      live(
        Effect.gen(function* resources() {
          const { request } = yield* connectMcp(
            yield* servingMcpHttp({ interface: mcpInterface })
          );
          const listed = Schema.decodeUnknownSync(ResourceList)(
            yield* request("resources/list", {})
          ).result.resources;
          for (const { topic } of DOC_TOPICS) {
            expect(listed).toContainEqual({
              mimeType: "text/markdown",
              uri: docUri(topic),
            });
            const read = Schema.decodeUnknownSync(ResourceRead)(
              yield* request("resources/read", { uri: docUri(topic) })
            ).result.contents;
            expect(read.map(({ text }) => text)).toEqual([
              yield* readTopic(topic),
            ]);
          }
        })
      ),
    HANG_GUARD_MS
  );
}

it.live(
  "reads a topic with docs_get and finds topics with search",
  () =>
    live(
      Effect.gen(function* docsGet() {
        const { request } = yield* connectMcp(
          yield* servingMcpHttp({ interface: "single-tool" })
        );
        const run = (code: string) =>
          request("tools/call", {
            arguments: { code },
            name: "agent_code_execute",
          }).pipe(
            Effect.map(
              (body) =>
                Schema.decodeUnknownSync(Execution)(body).result
                  .structuredContent
            )
          );
        const read = yield* run(
          'const doc = await tools.docs_get({ topic: "variables" }); return { title: doc.title, uri: doc.uri, markdown: doc.markdown }'
        );
        expect(read.status).toBe("completed");
        expect(read.value).toEqual({
          markdown: yield* readTopic("variables"),
          title: "Variables",
          uri: "contingency://docs/variables",
        });
        for (const query of ["settings", "emulation", "limits", "secret"]) {
          const searched = yield* run(
            `return search({ query: ${JSON.stringify(query)} }).items.map((item) => item.path)`
          );
          expect(searched.value, query).toContain("tools.docs_get");
        }
        const refused = yield* run(
          'return await tools.docs_get({ topic: "secrets" })'
        );
        expect(refused.status).toBe("program_failed");
      })
    ),
  HANG_GUARD_MS
);
