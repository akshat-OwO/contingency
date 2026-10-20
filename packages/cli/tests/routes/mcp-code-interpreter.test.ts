import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";
import type { JsonValue } from "../helpers/mcp-http.ts";

// One hang guard per test, sized for a hung process rather than the work.
const HANG_GUARD_MS = 60_000;

const SYSTEM_ONE = {
  apiKey: Option.none(),
  first: false,
  model: "system-one-test",
  url: "http://127.0.0.1:9/v1/systemone",
};

const ToolNames = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

const Listed = Schema.Struct({
  result: Schema.Struct({
    prompts: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String }))
    ),
    resources: Schema.optional(
      Schema.Array(Schema.Struct({ uri: Schema.String }))
    ),
  }),
});

const Initialized = Schema.Struct({
  result: Schema.Struct({ instructions: Schema.String }),
});

const Execution = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.Boolean,
    structuredContent: Schema.optional(
      Schema.Struct({
        diagnostic: Schema.optional(
          Schema.Struct({ kind: Schema.String, message: Schema.String })
        ),
        process: Schema.Struct({ bytesToInterpreter: Schema.Number }),
        receipts: Schema.Array(
          Schema.Struct({
            message: Schema.optional(Schema.String),
            operation: Schema.String,
            outcome: Schema.String,
          })
        ),
        status: Schema.String,
        value: Schema.optional(Schema.Unknown),
        valueResource: Schema.optional(
          Schema.Struct({
            bytes: Schema.Number,
            preview: Schema.String,
            uri: Schema.String,
          })
        ),
      })
    ),
  }),
});

const ResourceRead = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(
      Schema.Struct({ mimeType: Schema.String, text: Schema.String })
    ),
  }),
});

type Options = Parameters<typeof servingMcpHttp>[0];

const singleTool = (options: Options = {}) =>
  Effect.gen(function* connectSingleTool() {
    const origin = yield* servingMcpHttp({
      ...options,
      interface: "single-tool",
    });
    return yield* connectMcp(origin);
  });

const call = (code: string, extra: Record<string, JsonValue> = {}) =>
  Effect.gen(function* executeProgram() {
    const { request } = yield* singleTool();
    return yield* request("tools/call", {
      arguments: { code, ...extra },
      name: "agent_code_execute",
    });
  });

const execute = (code: string, extra: Record<string, JsonValue> = {}) =>
  call(code, extra).pipe(
    Effect.map((body) => Schema.decodeUnknownSync(Execution)(body).result)
  );

const Refusal = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});

const live = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.scoped,
    Effect.timeout(HANG_GUARD_MS),
    Effect.provide(NodeServices.layer)
  );

const SEARCH_ALL =
  'return search({ query: "", limit: 100 }).items.map((item) => item.path.replace("tools.", ""))';

/** What a native server registers, and what the same config offers inside programs. */
const coverage = (options: Options) =>
  Effect.gen(function* compareCatalogs() {
    const native = yield* connectMcp(yield* servingMcpHttp(options));
    const { tools } = Schema.decodeUnknownSync(ToolNames)(
      yield* native.request("tools/list", {})
    ).result;
    const { request } = yield* singleTool(options);
    const listed = Schema.decodeUnknownSync(ToolNames)(
      yield* request("tools/list", {})
    ).result.tools.map(({ name }) => name);
    const searched = Schema.decodeUnknownSync(Execution)(
      yield* request("tools/call", {
        arguments: { code: SEARCH_ALL },
        name: "agent_code_execute",
      })
    ).result.structuredContent;
    return {
      listed,
      native: tools.map(({ name }) => name).toSorted(),
      offered: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
        searched?.value
      ).toSorted(),
    };
  });

it.live(
  "serves the single tool by default and the native catalog only when chosen",
  () =>
    live(
      Effect.gen(function* defaultCatalog() {
        const names = Effect.fn("names")(function* names(
          mcpInterface: "default" | "native"
        ) {
          const { request } = yield* connectMcp(
            yield* servingMcpHttp({ interface: mcpInterface })
          );
          const { tools } = Schema.decodeUnknownSync(ToolNames)(
            yield* request("tools/list", {})
          ).result;
          return tools.map((tool) => tool.name);
        });
        expect(yield* names("default")).toEqual(["agent_code_execute"]);
        const native = yield* names("native");
        expect(native).not.toContain("agent_code_execute");
        expect(native).toContain("agent_session_start");
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "offers every native capability through one tool, keeping resources and prompts",
  () =>
    live(
      Effect.gen(function* everyCapability() {
        const base = yield* coverage({});
        expect(base.listed).toEqual(["agent_code_execute"]);
        expect(base.offered).toEqual(
          [...base.native, "agent_browser_devtools", "docs_get"].toSorted()
        );
        expect(base.native).not.toContain("agent_browser_devtools");
        // Docs are resources natively; programs also read them as an operation.
        expect(base.native).not.toContain("docs_get");
        expect(base.offered).toEqual(
          expect.arrayContaining([
            "agent_android_sessions_list",
            "agent_android_workspace",
          ])
        );
        // Conditional capabilities follow their prerequisites.
        const demo = yield* coverage({ demo: true });
        expect(demo.offered).toEqual(
          [...demo.native, "agent_browser_devtools", "docs_get"].toSorted()
        );
        expect(demo.offered).toContain("agent_example_run_start");
        const pursuit = yield* coverage({ systemOne: SYSTEM_ONE });
        expect(pursuit.offered).toEqual(
          [...pursuit.native, "agent_browser_devtools", "docs_get"].toSorted()
        );
        expect(pursuit.offered).toContain("agent_browser_pursue");

        const native = yield* connectMcp(yield* servingMcpHttp({ demo: true }));
        const single = yield* singleTool({ demo: true });
        for (const method of ["resources/list", "prompts/list"]) {
          expect(
            Schema.decodeUnknownSync(Listed)(yield* single.request(method, {}))
          ).toEqual(
            Schema.decodeUnknownSync(Listed)(yield* native.request(method, {}))
          );
        }
        const { instructions } = Schema.decodeUnknownSync(Initialized)(
          single.initialized
        ).result;
        expect(instructions).toContain("agent_code_execute");
        expect(instructions).toContain("search(");
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "sends signatures only to a program that searches them",
  () =>
    live(
      Effect.gen(function* signaturesOnDemand() {
        const signature = yield* execute(
          'return search({ query: "agent_session_get" }).items[0].signature'
        );
        expect(signature.structuredContent?.value).toEqual(
          expect.stringContaining("sessionId")
        );
        const plain = yield* execute("return 1");
        expect(
          plain.structuredContent?.process.bytesToInterpreter
        ).toBeLessThan(
          (signature.structuredContent?.process.bytesToInterpreter ?? 0) / 4
        );
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "dispatches an operation through the native handler",
  () =>
    live(
      Effect.gen(function* dispatch() {
        const answer = yield* execute(
          'const listed = await tools.agent_sessions_get({ view: "compact" }); return listed.sessions.length'
        );
        expect(answer.structuredContent?.status).toBe("completed");
        expect(answer.structuredContent?.value).toBe(0);
        expect(answer.structuredContent?.receipts).toEqual([
          { operation: "agent_sessions_get", outcome: "succeeded" },
        ]);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "rejects excess, invalid, and Workspace-only parameters in the server",
  () =>
    live(
      Effect.gen(function* strict() {
        const answer = yield* execute(`
          const refused = async (attempt) => {
            try {
              await attempt();
              return "accepted";
            } catch (error) {
              return "refused";
            }
          };
          return [
            await refused(() => tools.agent_sessions_get({ view: "compact", widen: true })),
            await refused(() => tools.agent_session_get({ sessionId: 7 })),
            await refused(() => tools.agent_android_workspace({ command: { _tag: "observe" } })),
            await refused(() => tools.agent_android_workspace({
              command: { _tag: "variable-supply", name: "PIN", operationId: "supply-1", requestId: "r", sessionId: "s", value: "1234" },
            })),
          ];
        `);
        expect(answer.structuredContent?.value).toEqual([
          "refused",
          "refused",
          "refused",
          "refused",
        ]);
        const receipts = answer.structuredContent?.receipts ?? [];
        expect(receipts.map(({ outcome }) => outcome)).toEqual([
          "failed",
          "failed",
          "failed",
          "failed",
        ]);
        expect(receipts[0]?.message).toContain("widen");
        // A refusal never echoes what it refused.
        expect(JSON.stringify(answer)).not.toContain("1234");
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "words a refusal exactly as the native tool does",
  () =>
    live(
      Effect.gen(function* sameRefusal() {
        const command = { _tag: "read", sessionId: "agent-android-missing" };
        const native = yield* connectMcp(yield* servingMcpHttp());
        const nativeAnswer = Schema.decodeUnknownSync(Execution)(
          yield* native.request("tools/call", {
            arguments: { command },
            name: "agent_android_workspace",
          })
        ).result;
        expect(nativeAnswer.isError).toBe(true);
        const answer = yield* execute(`
          try {
            await tools.agent_android_workspace({ command: ${JSON.stringify(command)} });
            return "accepted";
          } catch (error) {
            return error.message;
          }
        `);
        const [refusal] = nativeAnswer.content;
        expect(answer.structuredContent?.value).toBe(refusal?.text);
        expect(answer.structuredContent?.receipts[0]?.message).toBe(
          refusal?.text
        );
        expect(refusal?.text).not.toContain("    at ");
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "keeps a value too large to return inline behind a resource link",
  () =>
    live(
      Effect.gen(function* largeValue() {
        const { request } = yield* singleTool();
        const answer = Schema.decodeUnknownSync(Execution)(
          yield* request("tools/call", {
            arguments: {
              code: `const listed = await tools.agent_sessions_get({ view: "compact" });
                return { rows: Array.from({ length: 3000 }, (_, index) => "row-" + index), sessions: listed.sessions.length };`,
            },
            name: "agent_code_execute",
          })
        ).result.structuredContent;
        const expected = {
          rows: Array.from({ length: 3000 }, (_, index) => `row-${index}`),
          sessions: 0,
        };
        expect(answer?.status).toBe("completed");
        expect(answer?.value).toBeUndefined();
        expect(answer?.receipts.map(({ outcome }) => outcome)).toEqual([
          "succeeded",
        ]);
        const link = answer?.valueResource;
        expect(link?.bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
        expect(JSON.stringify(expected).startsWith(link?.preview ?? "-")).toBe(
          true
        );
        const read = Schema.decodeUnknownSync(ResourceRead)(
          yield* request("resources/read", { uri: link?.uri ?? "" })
        ).result;
        expect(read.contents.map(({ mimeType }) => mimeType)).toEqual([
          "application/json",
        ]);
        expect(JSON.parse(read.contents[0]?.text ?? "null")).toEqual(expected);

        const missing = Schema.decodeUnknownSync(Refusal)(
          yield* request("resources/read", {
            uri: "contingency://executions/exec-missing/value",
          })
        );
        expect(missing.error.message).toContain("expired or was never kept");
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "ends a program whose value passes the result limit, keeping its receipts",
  () =>
    live(
      Effect.gen(function* overLimit() {
        const answer = yield* execute(
          'await tools.agent_sessions_get({ view: "compact" }); return "x".repeat(1100000)'
        );
        expect(answer.structuredContent?.status).toBe("output_limit");
        expect(answer.structuredContent?.diagnostic?.kind).toBe(
          "OutputLimitExceeded"
        );
        expect(answer.structuredContent?.value).toBeUndefined();
        expect(answer.structuredContent?.valueResource).toBeUndefined();
        expect(answer.structuredContent?.receipts).toEqual([
          { operation: "agent_sessions_get", outcome: "succeeded" },
        ]);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "refuses an unknown operation before it reaches the server",
  () =>
    live(
      Effect.gen(function* unknown() {
        const answer = yield* execute(
          "return await tools.agent_unknown_operation({})"
        );
        expect(answer.structuredContent?.status).toBe("program_failed");
        expect(answer.structuredContent?.diagnostic?.kind).toBe("UnknownTool");
        expect(answer.structuredContent?.receipts).toEqual([]);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "accepts a budget for a full Session Event wait",
  () =>
    live(
      Effect.gen(function* longBudget() {
        const accepted = yield* execute("return 1", { timeoutMs: 120_000 });
        expect(accepted.structuredContent?.status).toBe("completed");
        const refused = Schema.decodeUnknownSync(Refusal)(
          yield* call("return 1", { timeoutMs: 120_001 })
        );
        expect(refused.error.message).toContain("timeoutMs");
      })
    ),
  HANG_GUARD_MS
);
