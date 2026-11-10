import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { LEARN_FLOW_URI } from "../../src/services/mcp-authoring-resources.ts";
import {
  DOCS_URI_PREFIX,
  GETTING_STARTED_URI,
} from "../../src/services/mcp-docs.ts";
import {
  EXAMPLES_URI,
  SESSION_GUIDE_HEADING,
} from "../../src/services/mcp-onboarding.ts";
import { McpProcessInfo } from "../../src/services/mcp-process-info.ts";
import { ONBOARDING_EXAMPLES } from "../../src/services/onboarding-examples.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const ResourceList = Schema.Struct({
  result: Schema.Struct({
    resources: Schema.Array(Schema.Struct({ uri: Schema.String })),
  }),
});

const ToolList = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

const ResourceRead = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
});

const read = (
  request: Effect.Success<ReturnType<typeof connectMcp>>["request"],
  uri: string
) =>
  request("resources/read", { uri }).pipe(
    Effect.map(
      (response) =>
        Schema.decodeUnknownSync(ResourceRead)(response).result.contents[0]
          ?.text ?? ""
    )
  );

/** The launch prompt URIs ADR 0069 retired in favor of getting-started. */
const RETIRED_URIS = [
  "contingency://onboarding/starter-prompt",
  "contingency://start/work-prompt",
];

const BASE_GUIDE = readFileSync(
  new URL("../../docs/getting-started.md", import.meta.url),
  "utf-8"
);

const listUris = (
  request: Effect.Success<ReturnType<typeof connectMcp>>["request"]
) =>
  request("resources/list", {}).pipe(
    Effect.map((response) =>
      Schema.decodeUnknownSync(ResourceList)(response).result.resources.map(
        (resource) => resource.uri
      )
    )
  );

/** A GET with an explicit Host header, as a browser resolving the name sends it. */
const getWithHost = (port: number, host: string, path: string) =>
  Effect.callback<{ readonly body: string; readonly status: number }>(
    (resume) => {
      const outgoing = httpRequest(
        { headers: { host }, host: "127.0.0.1", method: "GET", path, port },
        (response) => {
          let body = "";
          response.setEncoding("utf-8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resume(Effect.succeed({ body, status: response.statusCode ?? 0 }));
          });
        }
      );
      outgoing.on("error", (cause) => {
        resume(Effect.die(cause));
      });
      outgoing.end();
    }
  );

it.live(
  "appends the demo onboarding procedure to getting-started and serves this process's examples",
  () =>
    Effect.gen(function* onboardingResources() {
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({ demo: true })
      );
      const uris = yield* listUris(request);
      expect(uris).toEqual(
        expect.arrayContaining([
          GETTING_STARTED_URI,
          EXAMPLES_URI,
          LEARN_FLOW_URI,
        ])
      );
      for (const retired of RETIRED_URIS) {
        expect(uris).not.toContain(retired);
      }

      const guide = yield* read(request, GETTING_STARTED_URI);
      expect(guide.startsWith(BASE_GUIDE.trimEnd())).toBe(true);
      expect(guide).toContain(SESSION_GUIDE_HEADING);
      expect(guide).toContain("### Demo onboarding");
      expect(guide).toContain("agent_example_run_start");
      expect(guide).toContain(LEARN_FLOW_URI);
      expect(guide).not.toContain("### Work session");
      // One authoritative learning procedure: the guide points to it.
      expect(guide).not.toContain("agent_teaching_recording_claim");

      const learn = yield* read(request, LEARN_FLOW_URI);
      expect(learn).toContain("agent_flow_save");
      expect(learn).toContain("agent_session_get");
      expect(learn).toContain("afterCursor:eventCursor");
      expect(learn).toContain(
        "Relay a conversation choice with agent_flow_decide"
      );

      const examples = yield* read(request, EXAMPLES_URI);
      for (const example of ONBOARDING_EXAMPLES) {
        expect(examples).toContain(example.flowName);
      }
      const origin = /http:\/\/ridgeline\.localhost:(?<port>\d+)\//u.exec(
        examples
      );
      expect(origin).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("serves the demo store only under its hostname and port", () =>
  Effect.gen(function* demoHostGuard() {
    const { request } = yield* connectMcp(
      yield* servingMcpHttp({ demo: true })
    );
    const examples = yield* read(request, EXAMPLES_URI);
    const port = Number(
      /http:\/\/ridgeline\.localhost:(?<port>\d+)\//u.exec(examples)?.groups
        ?.port
    );
    const home = yield* getWithHost(port, `ridgeline.localhost:${port}`, "/");
    expect(home.status).toBe(200);
    expect(home.body).toContain(
      "Ridgeline Hardware is a Contingency demo store"
    );
    const script = yield* getWithHost(
      port,
      `ridgeline.localhost:${port}`,
      "/app.js"
    );
    expect(script.status).toBe(200);
    expect((yield* getWithHost(port, `127.0.0.1:${port}`, "/")).status).toBe(
      421
    );
    expect((yield* getWithHost(port, `evil.test:${port}`, "/")).status).toBe(
      421
    );
    expect(
      (yield* getWithHost(
        port,
        `ridgeline.localhost:${port}`,
        "/../package.json"
      )).status
    ).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "appends the work procedure to getting-started without the demo store, its examples, or the Example tool",
  () =>
    Effect.gen(function* workResources() {
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({
          launchContext: "### Launch context\n\n- Connection: session-only",
        })
      );
      const uris = yield* listUris(request);
      expect(uris).toEqual(
        expect.arrayContaining([GETTING_STARTED_URI, LEARN_FLOW_URI])
      );
      expect(uris).not.toContain(EXAMPLES_URI);
      for (const retired of RETIRED_URIS) {
        expect(uris).not.toContain(retired);
      }

      const tools = Schema.decodeUnknownSync(ToolList)(
        yield* request("tools/list", {})
      ).result.tools.map((tool) => tool.name);
      expect(tools).toEqual(["agent_code_execute"]);
      expect(tools).not.toContain("agent_example_run_start");

      const guide = yield* read(request, GETTING_STARTED_URI);
      expect(guide.startsWith(BASE_GUIDE.trimEnd())).toBe(true);
      expect(guide).toContain(SESSION_GUIDE_HEADING);
      expect(guide).toContain("### Work session");
      expect(guide).toContain("- Connection: session-only");
      expect(guide).toContain(LEARN_FLOW_URI);
      expect(guide).toContain("--demo");
      expect(guide).not.toContain("agent_example_run_start");
      // One authoritative learning procedure: the guide points to it.
      expect(guide).not.toContain("agent_teaching_recording_claim");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("serves the packaged guide unchanged to a registered server", () =>
  Effect.gen(function* registeredGuide() {
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    const guide = yield* read(request, GETTING_STARTED_URI);
    expect(guide).toBe(BASE_GUIDE);
    expect(guide).not.toContain(SESSION_GUIDE_HEADING);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const DocsGetResult = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      value: Schema.Struct({ markdown: Schema.String }),
    }),
  }),
});

it.live(
  "delivers process-local launch context through getting-started and docs_get",
  () =>
    Effect.gen(function* processContext() {
      const first = yield* connectMcp(
        yield* servingMcpHttp({
          demo: true,
          launchContext:
            "### Launch context\n\n- Working directory: /work/first\n- Catalog Root: /work/first/.contingency\n- Connection: session-only\n- Reconnect command: contingency start --agent codex",
        })
      );
      const second = yield* connectMcp(
        yield* servingMcpHttp({
          launchContext:
            "### Launch context\n\n- Working directory: /work/second\n- Catalog Root: /work/second/.contingency\n- Connection: session-only",
        })
      );
      const viaDocsGet = (
        request: Effect.Success<ReturnType<typeof connectMcp>>["request"]
      ) =>
        request("tools/call", {
          arguments: {
            code: 'return await tools.docs_get({ topic: "getting-started" })',
          },
          name: "agent_code_execute",
        }).pipe(
          Effect.map(
            (body) =>
              Schema.decodeUnknownSync(DocsGetResult)(body).result
                .structuredContent.value.markdown
          )
        );
      const resource = yield* read(first.request, GETTING_STARTED_URI);
      expect(yield* viaDocsGet(first.request)).toBe(resource);
      expect(resource).toContain("/work/first/.contingency");
      expect(resource).toContain("contingency start --agent codex");
      expect(resource).toContain("workspaceUrl");
      expect(resource).toContain("viewUrl");
      expect(resource).not.toContain("/work/second");

      const other = yield* read(second.request, GETTING_STARTED_URI);
      expect(yield* viaDocsGet(second.request)).toBe(other);
      expect(other).toContain("/work/second/.contingency");
      expect(other).not.toContain("/work/first");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const SearchResult = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({ value: Schema.Array(Schema.String) }),
  }),
});

/** Launch and procedure prompts, which must each name at least one tool. */
const isPrompt = (value: string) =>
  value.startsWith("contingency://onboarding/") ||
  value.startsWith("contingency://prompt/");

/** An agent works without announcing itself or its harness. */
const SELF_INTRODUCTION =
  /\bIntroduce (?:yourself|the agent)\b|\bName the agent\b/u;

it.live(
  "keeps every prompt and docs reference resolvable in the live catalog",
  () =>
    Effect.gen(function* promptToolContract() {
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({
          demo: true,
          launchContext: "### Launch context\n\n- Connection: session-only",
          systemOne: {
            apiKey: Option.none(),
            first: false,
            model: "test",
            url: "http://127.0.0.1:9",
          },
        })
      );
      const names = Schema.decodeUnknownSync(SearchResult)(
        yield* request("tools/call", {
          name: "agent_code_execute",
          arguments: {
            code: 'return search({ query: "", limit: 100 }).items.map(item => item.path.replace("tools.", ""))',
          },
        })
      ).result.structuredContent.value;
      const catalog = new Set([...names, "agent_code_execute"]);
      const uris = Schema.decodeUnknownSync(ResourceList)(
        yield* request("resources/list", {})
      ).result.resources.map(({ uri }) => uri);
      const served = new Set(uris);
      for (const uri of uris.filter(
        (value) => isPrompt(value) || value.startsWith(DOCS_URI_PREFIX)
      )) {
        const text = yield* read(request, uri);
        expect(text, uri).not.toMatch(SELF_INTRODUCTION);
        const mentioned = [...text.matchAll(/\bagent_[A-Za-z0-9_]+\b/gu)].map(
          ([name]) => name
        );
        if (isPrompt(uri)) {
          expect(mentioned.length, uri).toBeGreaterThan(0);
        }
        for (const name of mentioned) {
          expect(catalog.has(name), `${uri}: ${name}`).toBe(true);
        }
        // A guide that names a resource this server does not serve sends the
        // agent to a dead end, so every reference must resolve.
        for (const [reference] of text.matchAll(
          /contingency:\/\/[a-z-]+(?:\/[a-z-]+)+/gu
        )) {
          expect(served.has(reference), `${uri}: ${reference}`).toBe(true);
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer)
    ),
  60_000
);

const CodeProcessResult = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      value: Schema.Struct({ process: McpProcessInfo }),
    }),
  }),
});
it.live(
  "reports process diagnostics through agent_catalog_get",
  () =>
    Effect.gen(function* catalogProcess() {
      const { request } = yield* connectMcp(yield* servingMcpHttp());
      const response = yield* request("tools/call", {
        name: "agent_code_execute",
        arguments: { code: "return await tools.agent_catalog_get({})" },
      });
      expect(response).not.toHaveProperty(
        "result.structuredContent.value.process.mcpInterface"
      );
      expect(response).not.toHaveProperty(
        "result.structuredContent.value.process.settings.fileInterface"
      );
      const { process } =
        Schema.decodeUnknownSync(CodeProcessResult)(response).result
          .structuredContent.value;
      expect(process.platforms).toEqual(["browser"]);
      expect(process.settings.sources).toEqual(["defaults"]);
      expect(process.settings.restartRequired).toBe(false);
      expect(process.systemOne).toMatchObject({
        kind: "not-configured",
        available: false,
        reachable: null,
      });
    }).pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer)
    ),
  60_000
);

const CatalogLinks = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      value: Schema.Struct({
        docsUrl: Schema.String,
        guide: Schema.String,
        workspaceUrl: Schema.String,
      }),
    }),
  }),
});

it.live(
  "links the docs site beside the Workspace from agent_catalog_get",
  () =>
    Effect.gen(function* catalogDocs() {
      const { request } = yield* connectMcp(yield* servingMcpHttp());
      const { value } = Schema.decodeUnknownSync(CatalogLinks)(
        yield* request("tools/call", {
          name: "agent_code_execute",
          arguments: { code: "return await tools.agent_catalog_get({})" },
        })
      ).result.structuredContent;
      expect(value.guide).toBe(GETTING_STARTED_URI);
      expect(value.docsUrl).toBe(new URL("/docs", value.workspaceUrl).href);
    }).pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer)
    ),
  60_000
);
