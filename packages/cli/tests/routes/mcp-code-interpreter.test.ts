import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";
import type { JsonValue } from "../helpers/mcp-http.ts";

// One hang guard per test, sized for a hung process rather than the work.
const HANG_GUARD_MS = 60_000;

const ToolNames = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
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
        receipts: Schema.Array(
          Schema.Struct({
            message: Schema.optional(Schema.String),
            operation: Schema.String,
            outcome: Schema.String,
          })
        ),
        status: Schema.String,
        value: Schema.optional(Schema.Unknown),
      })
    ),
  }),
});

const call = (code: string, extra: Record<string, JsonValue> = {}) =>
  Effect.gen(function* executeProgram() {
    const origin = yield* servingMcpHttp({ codeInterpreter: true });
    const { request } = yield* connectMcp(origin);
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

it.live(
  "leaves the interpreter prototype out of the default catalog",
  () =>
    live(
      Effect.gen(function* defaultCatalog() {
        const origin = yield* servingMcpHttp();
        const { request } = yield* connectMcp(origin);
        const { tools } = Schema.decodeUnknownSync(ToolNames)(
          yield* request("tools/list", {})
        ).result;
        expect(tools.map((tool) => tool.name)).not.toContain(
          "agent_code_execute"
        );
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "returns operation signatures from a search-only execution",
  () =>
    live(
      Effect.gen(function* search() {
        const answer = yield* execute(
          'return search({ query: "" }).items.map((item) => item.path)'
        );
        expect(answer.structuredContent?.status).toBe("completed");
        expect(answer.structuredContent?.value).toEqual([
          "tools.agent_browser_act",
          "tools.agent_browser_snapshot",
          "tools.agent_session_get",
          "tools.agent_sessions_get",
        ]);
        expect(answer.structuredContent?.receipts).toEqual([]);
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
  "validates operation parameters strictly in the server, not the interpreter",
  () =>
    live(
      Effect.gen(function* strict() {
        const answer = yield* execute(`
          try {
            await tools.agent_sessions_get({ view: "compact", widen: true });
            return "accepted";
          } catch (error) {
            return "refused";
          }
        `);
        expect(answer.structuredContent?.value).toBe("refused");
        const [receipt] = answer.structuredContent?.receipts ?? [];
        expect(receipt?.outcome).toBe("failed");
        expect(receipt?.message).toContain("widen");
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
          'return await tools.agent_session_close({ sessionId: "x" })'
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
