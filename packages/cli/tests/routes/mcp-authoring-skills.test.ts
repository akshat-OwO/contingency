import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import {
  AUTHORING_SKILL_FILES,
  authoringSkillUri,
  resolveAuthoringSkillRoot,
} from "../../src/services/mcp-authoring-skills.ts";
import {
  MCP_HTTP_PATH,
  makeMcpHttpLayer,
} from "../../src/services/mcp-http.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const ResourceList = Schema.Struct({
  result: Schema.Struct({
    resources: Schema.Array(
      Schema.Struct({
        mimeType: Schema.optional(Schema.String),
        name: Schema.String,
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

const PromptList = Schema.Struct({
  result: Schema.Struct({
    prompts: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

const serving = Effect.fn("servingAuthoringSkills")(
  function* servingAuthoringSkills() {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped();
    const baseUrl = "http://127.0.0.1:7791";
    const context = yield* Layer.build(
      HttpRouter.serve(makeMcpHttpLayer(new Set([baseUrl]))).pipe(
        Layer.provide(
          Layer.mergeAll(
            makeAgentSessionLayer({ allowedActivity: "any", baseUrl }),
            makeFlowSkillCatalogLayer({ root: catalogRoot }),
            makeAgentRunStoreLayer({ root: () => catalogRoot }),
            makeTeachingRecordingStoreLayer({ root: () => catalogRoot })
          ).pipe(
            Layer.provideMerge(CreateBrowserLive),
            Layer.provideMerge(NodeServices.layer)
          )
        ),
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
        )
      )
    );
    const server = Context.get(context, HttpServer.HttpServer);
    const { address } = server;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die("Expected a TCP server.");
    }
    return `http://127.0.0.1:${address.port}`;
  }
);

const post = (origin: string, sessionId: string | null, body: string) =>
  Effect.promise(() => {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    });
    if (sessionId !== null) {
      headers.set("mcp-session-id", sessionId);
    }
    return fetch(`${origin}${MCP_HTTP_PATH}`, {
      body,
      headers,
      method: "POST",
    });
  });

/** One initialized MCP client, holding the session id the server issued. */
const connect = (origin: string) =>
  Effect.gen(function* initializeMcpClient() {
    const initialized = yield* post(
      origin,
      null,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "verify", version: "1.0" },
          protocolVersion: "2025-06-18",
        },
      })
    );
    expect(initialized.status, "initialize").toBe(200);
    yield* Effect.promise(() => initialized.text());
    const sessionId = initialized.headers.get("mcp-session-id");
    yield* post(
      origin,
      sessionId,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    return <S extends Schema.Top>(
      schema: S,
      id: number,
      method: string,
      params: Record<string, string>
    ) =>
      Effect.gen(function* callMcp() {
        const response = yield* post(
          origin,
          sessionId,
          JSON.stringify({ id, jsonrpc: "2.0", method, params })
        );
        expect(response.status, method).toBe(200);
        const payload: unknown = yield* Effect.promise(() => response.json());
        return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
          Effect.orDie
        );
      });
  });

it.live(
  "serves the three authoring skills as MCP resources, and never skill-creator",
  () =>
    Effect.gen(function* listAuthoringSkillResources() {
      const call = yield* connect(yield* serving());
      const listed = yield* call(ResourceList, 2, "resources/list", {});
      const { resources } = listed.result;
      const uris = resources.map((resource) => resource.uri);
      for (const entry of AUTHORING_SKILL_FILES) {
        expect(uris).toContain(authoringSkillUri(entry));
      }
      expect(JSON.stringify(resources)).not.toContain("skill-creator");
      expect(
        resources
          .filter((resource) => resource.uri.startsWith("contingency://skill/"))
          .every((resource) => resource.mimeType === "text/markdown")
      ).toBe(true);

      const read = yield* call(ResourceRead, 3, "resources/read", {
        uri: "contingency://skill/writing-for-agents",
      });
      expect(read.result.contents[0]?.text).toContain(
        "name: writing-for-agents"
      );

      const mechanics = yield* call(ResourceRead, 4, "resources/read", {
        uri: "contingency://skill/writing-for-agents/SKILL-MECHANICS.md",
      });
      expect(mechanics.result.contents[0]?.text).toContain("# Skill mechanics");

      const prompts = yield* call(PromptList, 5, "prompts/list", {});
      expect(prompts.result.prompts.map((prompt) => prompt.name)).toContain(
        "learn-flow-skill"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "reads the vendored skills from the CLI install even when HOME holds no skills",
  () =>
    Effect.gen(function* readWithoutHostSkills() {
      const fileSystem = yield* FileSystem.FileSystem;
      const emptyHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-empty-home-",
      });
      const previousHome = process.env.HOME;
      process.env.HOME = emptyHome;
      const origin = yield* Effect.acquireRelease(serving(), () =>
        Effect.sync(() => {
          process.env.HOME = previousHome;
        })
      );
      const call = yield* connect(origin);
      const read = yield* call(ResourceRead, 2, "resources/read", {
        uri: "contingency://skill/unslop",
      });
      expect(read.result.contents[0]?.text).toContain("name: unslop");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("keeps the vendored skills inside the published package", () =>
  Effect.gen(function* checkVendoredFiles() {
    const fileSystem = yield* FileSystem.FileSystem;
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    for (const entry of AUTHORING_SKILL_FILES) {
      expect(
        yield* fileSystem.exists(
          path.join(packageRoot, "skills", entry.skill, entry.file)
        ),
        `${entry.skill}/${entry.file}`
      ).toBe(true);
    }
    expect(
      yield* fileSystem.exists(
        path.join(packageRoot, "skills", "skill-creator")
      )
    ).toBe(false);
    // The built CLI resolves them beside the bundle, the same shape the web UI
    // uses. A build that forgets the copy ships empty resources to npm.
    expect(resolveAuthoringSkillRoot("/opt/contingency/dist")).toBe(
      "/opt/contingency/dist/skills"
    );
    const built = path.join(packageRoot, "dist", "skills");
    if (yield* fileSystem.exists(path.join(packageRoot, "dist"))) {
      for (const entry of AUTHORING_SKILL_FILES) {
        expect(
          yield* fileSystem.exists(path.join(built, entry.skill, entry.file)),
          `dist/skills/${entry.skill}/${entry.file}`
        ).toBe(true);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer))
);
