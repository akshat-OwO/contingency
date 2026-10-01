import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const ToolNames = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});

const CodeRunResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.Boolean,
    structuredContent: Schema.optional(
      Schema.Struct({ calls: Schema.Number, result: Schema.Unknown })
    ),
  }),
});

const runScript = (code: string, timeoutMs?: number) =>
  Effect.gen(function* runCodeTool() {
    const origin = yield* servingMcpHttp({ codeMode: true });
    const { request } = yield* connectMcp(origin);
    const body = yield* request("tools/call", {
      arguments: timeoutMs === undefined ? { code } : { code, timeoutMs },
      name: "agent_code_run",
    });
    return Schema.decodeUnknownSync(CodeRunResult)(body).result;
  });

it.live("leaves sandboxed code orchestration out of the default catalog", () =>
  Effect.gen(function* defaultCatalog() {
    const origin = yield* servingMcpHttp();
    const { request } = yield* connectMcp(origin);
    const { tools } = Schema.decodeUnknownSync(ToolNames)(
      yield* request("tools/list", {})
    ).result;
    expect(tools.map((tool) => tool.name)).not.toContain("agent_code_run");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("aggregates read-only tool results inside the sandbox", () =>
  Effect.gen(function* aggregate() {
    const answer = yield* runScript(`
      const listed = contingency.call("agent_flow_skills_list", {});
      const catalog = contingency.call("agent_catalog_get", {});
      return { flowSkills: listed.flowSkills.length, counted: typeof catalog };
    `);
    expect(answer.isError).toBe(false);
    expect(answer.structuredContent).toEqual({
      calls: 2,
      result: { counted: "object", flowSkills: 0 },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("refuses every tool that is not read-only", () =>
  Effect.gen(function* refuseWrites() {
    const answer = yield* runScript(`
      try {
        contingency.call("agent_session_start", {});
        return "started";
      } catch (error) {
        return error.message;
      }
    `);
    expect(answer.structuredContent?.result).toBe(
      "agent_session_start is not a read-only Contingency tool."
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("exposes no host capability beyond the read-only bridge", () =>
  Effect.gen(function* noHostCapability() {
    const answer = yield* runScript(`
      return [typeof require, typeof process, typeof fetch, typeof setTimeout,
        typeof __contingencyCall, typeof contingency.call];
    `);
    expect(answer.structuredContent?.result).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "function",
      "function",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("stops a script at its time budget", () =>
  Effect.gen(function* timeBudget() {
    const started = Date.now();
    const answer = yield* runScript("while (true) {}", 200);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toContain("time budget");
    expect(Date.now() - started).toBeLessThan(5000);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("stops a script at its memory budget", () =>
  Effect.gen(function* memoryBudget() {
    const answer = yield* runScript(
      'let grown = "x"; while (true) { grown += grown; }'
    );
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toContain("code_run_failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("refuses a result too large to return to the model", () =>
  Effect.gen(function* resultBudget() {
    const answer = yield* runScript('return "x".repeat(20000);');
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toContain("code_run_result_too_large");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
