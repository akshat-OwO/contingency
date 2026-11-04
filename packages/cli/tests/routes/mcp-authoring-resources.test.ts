import { createServer } from "node:http";
import path from "node:path";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import {
  LEARN_FLOW_URI,
  WRITING_RESOURCE_URI,
  resolveAuthoringResourceRoot,
} from "../../src/services/mcp-authoring-resources.ts";
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

const PromptGet = Schema.Struct({
  result: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({ content: Schema.Struct({ text: Schema.String }) })
    ),
  }),
});

const serving = Effect.fn("servingAuthoringSkills")(
  function* servingAuthoringSkills() {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped();
    const baseUrl = "http://127.0.0.1:7791";
    const context = yield* Layer.build(
      HttpRouter.serve(makeMcpHttpLayer(new Set([baseUrl]), {})).pipe(
        Layer.provide(
          Layer.mergeAll(
            makeAgentSessionLayer({ allowedActivity: "any", baseUrl }),
            makeFlowCatalogLayer({ root: catalogRoot }),
            makeAgentRunStoreLayer({ root: () => catalogRoot }),
            makeTeachingRecordingStoreLayer({ root: () => catalogRoot }),
            makeDemoSiteLayer()
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
    if (address._tag === "UnixPathAddress") {
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
  "serves one combined writing reference and points the learning prompt to it",
  () =>
    Effect.gen(function* listAuthoringSkillResources() {
      const call = yield* connect(yield* serving());
      const listed = yield* call(ResourceList, 2, "resources/list", {});
      const { resources } = listed.result;
      const uris = resources.map((resource) => resource.uri);
      expect(
        resources.filter((resource) => resource.uri === WRITING_RESOURCE_URI)
      ).toEqual([
        {
          uri: WRITING_RESOURCE_URI,
          name: "Writing",
          mimeType: "text/markdown",
        },
      ]);
      expect(uris.some((uri) => uri.startsWith("contingency://skill/"))).toBe(
        false
      );
      expect(JSON.stringify(resources)).not.toContain("skill-creator");
      const read = yield* call(ResourceRead, 3, "resources/read", {
        uri: WRITING_RESOURCE_URI,
      });
      const text = read.result.contents[0]?.text;
      const fileSystem = yield* FileSystem.FileSystem;
      expect(text).toBe(
        yield* fileSystem.readFileString(
          path.resolve(import.meta.dirname, "../../resources/writing.md")
        )
      );
      expect(text).toMatch(/^# Writing\n/u);
      expect(text).toContain("Diátaxis");
      expect(text).toContain("## Edit for natural voice");
      expect(text).toContain("## Write for agents");
      expect(text).not.toContain("name: unslop");

      const prompts = yield* call(PromptList, 5, "prompts/list", {});
      expect(prompts.result.prompts.map((prompt) => prompt.name)).toContain(
        "learn-flow"
      );
      const prompt = yield* call(PromptGet, 6, "prompts/get", {
        name: "learn-flow",
      });
      const instructions = prompt.result.messages
        .map((message) => message.content.text)
        .join("\n");
      const procedure = yield* fileSystem.readFileString(
        path.resolve(import.meta.dirname, "../../resources/learn-flow.md")
      );
      const learningResource = yield* call(ResourceRead, 7, "resources/read", {
        uri: LEARN_FLOW_URI,
      });
      expect(instructions).toBe(procedure);
      expect(learningResource.result.contents[0]?.text).toBe(procedure);
      expect(uris).toContain(LEARN_FLOW_URI);
      expect(instructions).toContain(WRITING_RESOURCE_URI);
      expect(instructions).not.toContain("contingency://skill/");
      expect(instructions).toContain("agent_run_assess");
      expect(instructions).toContain("outcomeComplete");
      expect(instructions).toContain("agent_run_complete");
      expect(instructions).toContain(
        "Completion is required for a passing report too."
      );
      expect(instructions).not.toContain("agent_run_step_assess");
      expect(instructions.indexOf("agent_run_assess")).toBeLessThan(
        instructions.indexOf("agent_run_complete")
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "reads the packaged writing reference even when HOME holds no skills",
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
        uri: WRITING_RESOURCE_URI,
      });
      expect(read.result.contents[0]?.text).toMatch(/^# Writing\n/u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("keeps authoring references inside the published package", () =>
  Effect.gen(function* checkPackagedReference() {
    const fileSystem = yield* FileSystem.FileSystem;
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    for (const file of ["writing.md", "learn-flow.md"]) {
      expect(
        yield* fileSystem.exists(path.join(packageRoot, "resources", file))
      ).toBe(true);
      if (yield* fileSystem.exists(path.join(packageRoot, "dist"))) {
        expect(
          yield* fileSystem.readFileString(
            path.join(packageRoot, "dist", "resources", file)
          )
        ).toBe(
          yield* fileSystem.readFileString(
            path.join(packageRoot, "resources", file)
          )
        );
      }
    }
    expect(yield* fileSystem.exists(path.join(packageRoot, "skills"))).toBe(
      false
    );
    expect(resolveAuthoringResourceRoot("/opt/contingency/dist")).toBe(
      "/opt/contingency/dist/resources"
    );
    expect(
      resolveAuthoringResourceRoot(path.join(packageRoot, "src", "services"))
    ).toBe(path.join(packageRoot, "resources"));
    const manifest = yield* fileSystem.readFileString(
      path.join(packageRoot, "package.json")
    );
    expect(manifest).toContain('"resources"');
    expect(manifest).toContain("['resources','dist/resources']");
  }).pipe(Effect.provide(NodeServices.layer))
);
