import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  MCP_INSTRUCTIONS,
  makeMcpInstructions,
} from "../../src/services/mcp-http.ts";
import {
  connectMcp,
  servingMcpHttp,
  statelessMcp,
} from "../helpers/mcp-http.ts";

const ListedToolSchema = Schema.Struct({
  annotations: Schema.optional(
    Schema.Struct({
      destructiveHint: Schema.optional(Schema.Boolean),
      readOnlyHint: Schema.optional(Schema.Boolean),
    })
  ),
  description: Schema.String,
  inputSchema: Schema.Unknown,
  name: Schema.String,
  outputSchema: Schema.optional(Schema.Unknown),
});
type ListedTool = typeof ListedToolSchema.Type;

const ToolList = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(ListedToolSchema) }),
});

const Initialized = Schema.Struct({
  result: Schema.Struct({
    instructions: Schema.optional(Schema.String),
    protocolVersion: Schema.String,
  }),
});

const bytes = (value: ListedTool | readonly ListedTool[]) =>
  JSON.stringify(value).length;

/**
 * The emitted catalog is what every client that lists tools pays for. These
 * budgets fail the build when a schema change inflates it, the way #326 to
 * #331 grew it from 140 KB to 216 KB without anyone noticing (ADR 0045).
 */
// The Android tools (about 7.3 KB) joined every catalog when Android left its opt-in (#489).
const CATALOG_BUDGET_BYTES = 91_000;
const TOOL_BUDGET_BYTES = 12_000;

const READ_ONLY_TOOLS = new Set([
  "agent_android_sessions_list",
  "agent_browser_screenshot",
  "agent_browser_snapshot",
  "agent_catalog_get",
  "agent_flow_skills_list",
  "agent_session_get",
  "agent_session_history_get",
  "agent_sessions_get",
  "agent_teaching_keyframe_get",
  "agent_teaching_recordings_list",
  "agent_teaching_timeline_get",
  "open_run",
]);

// Route tests serve native unless they choose; compare like with like.
const NATIVE_INSTRUCTIONS = makeMcpInstructions(false, undefined, "native");

it.live("lists the bounded Android tools without an opt-in", () =>
  Effect.gen(function* androidTools() {
    const origin = yield* servingMcpHttp();
    const { tools } = Schema.decodeUnknownSync(ToolList)(
      yield* (yield* connectMcp(origin)).request("tools/list", {})
    ).result;
    const android = tools.filter((tool) =>
      tool.name.startsWith("agent_android_")
    );
    expect(android.map((tool) => tool.name).toSorted()).toEqual([
      "agent_android_sessions_list",
      "agent_android_workspace",
    ]);
    expect(bytes(android)).toBeLessThanOrEqual(10_000);
    for (const tool of android) {
      expect(bytes(tool)).toBeLessThanOrEqual(TOOL_BUDGET_BYTES);
    }
  }).pipe(Effect.provide(NodeServices.layer))
);

it.live("keeps the emitted tool catalog inside its byte budget", () =>
  Effect.gen(function* catalogBudget() {
    const origin = yield* servingMcpHttp();
    const { request } = yield* connectMcp(origin);
    const { tools } = Schema.decodeUnknownSync(ToolList)(
      yield* request("tools/list", {})
    ).result;

    expect(tools).toHaveLength(37);
    expect(tools.map((tool) => tool.name)).toContain("agent_variable_request");
    expect(tools.map((tool) => tool.name)).not.toContain(
      "agent_run_variable_request"
    );
    expect(tools.map((tool) => tool.name)).not.toContain(
      "agent_teaching_setup_variable_request"
    );
    expect(bytes(tools)).toBeLessThanOrEqual(CATALOG_BUDGET_BYTES);
    for (const tool of tools) {
      expect(bytes(tool), tool.name).toBeLessThanOrEqual(TOOL_BUDGET_BYTES);
      // Shared protocol shapes are referenced, never inlined twice.
      expect(JSON.stringify(tool.outputSchema ?? {}), tool.name).not.toContain(
        '"captureState"'
      );
      expect(JSON.stringify(tool.outputSchema ?? {}), tool.name).not.toContain(
        '"androidVersion"'
      );
    }
    expect(tools.map((tool) => tool.name)).not.toContain(
      "agent_run_step_assess"
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const systemOne = {
  apiKey: Option.none(),
  first: false,
  model: "jev-latest",
  url: "http://127.0.0.1:8009/v1/systemone",
};

it.live("lists agent_browser_pursue only when System One is configured", () =>
  Effect.gen(function* pursuitAvailability() {
    const listed = (origin: string) =>
      Effect.gen(function* listTools() {
        const { request } = yield* connectMcp(origin);
        return Schema.decodeUnknownSync(ToolList)(
          yield* request("tools/list", {})
        ).result.tools;
      });
    const plain = yield* listed(yield* servingMcpHttp());
    expect(plain.map((tool) => tool.name)).not.toContain(
      "agent_browser_pursue"
    );
    const configured = yield* listed(yield* servingMcpHttp({ systemOne }));
    const pursue = configured.find(
      (tool) => tool.name === "agent_browser_pursue"
    );
    expect(configured).toHaveLength(plain.length + 1);
    expect(pursue?.annotations?.readOnlyHint).toBe(false);
    expect(bytes(configured)).toBeLessThanOrEqual(CATALOG_BUDGET_BYTES);
    expect(pursue === undefined ? 0 : bytes(pursue)).toBeLessThanOrEqual(
      TOOL_BUDGET_BYTES
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it("tells the agent to try a Pursuit first only under the experimental flag", () => {
  expect(makeMcpInstructions(false, systemOne, "native")).toBe(
    NATIVE_INSTRUCTIONS
  );
  const first = makeMcpInstructions(
    false,
    { ...systemOne, first: true },
    "native"
  );
  expect(first).toContain("Try agent_browser_pursue for each Flow Skill step");
  expect(first.length).toBeLessThan(800);
  const program = makeMcpInstructions(false, { ...systemOne, first: true });
  expect(program).toContain("Try tools.agent_browser_pursue for each");
  expect(makeMcpInstructions(false, systemOne)).not.toContain("pursue");
});

it.live("annotates read-only tools so hosts may run them concurrently", () =>
  Effect.gen(function* readOnlyHints() {
    const origin = yield* servingMcpHttp();
    const { request } = yield* connectMcp(origin);
    const { tools } = Schema.decodeUnknownSync(ToolList)(
      yield* request("tools/list", {})
    ).result;
    for (const tool of tools) {
      const readOnly = READ_ONLY_TOOLS.has(tool.name);
      expect(
        {
          destructive: tool.annotations?.destructiveHint,
          readOnly: tool.annotations?.readOnlyHint,
        },
        tool.name
      ).toEqual({ destructive: !readOnly, readOnly });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it("builds distinct channel instructions within the server budget", () => {
  const channel = makeMcpInstructions(true, undefined, "native");
  expect(channel).not.toBe(NATIVE_INSTRUCTIONS);
  expect(channel).toContain(
    "meta.sessionId and meta.eventCursor as afterCursor"
  );
  expect(channel).toContain("Otherwise wait with afterCursor and waitMs");
  expect(channel.length).toBeLessThan(800);
});

it.live("sends the context-saving habits as server instructions", () =>
  Effect.gen(function* serverInstructions() {
    const origin = yield* servingMcpHttp();
    const { initialized } = yield* connectMcp(origin);
    const decoded = Schema.decodeUnknownSync(Initialized)(initialized);
    expect(decoded.result.instructions).toBe(NATIVE_INSTRUCTIONS);
    expect(NATIVE_INSTRUCTIONS.length).toBeLessThan(800);
    expect(MCP_INSTRUCTIONS).toBe(
      makeMcpInstructions(false, undefined, "single-tool")
    );
    // The single tool carries the habits its one schema cannot, and the #461
    // evaluation measured this text; its catalog is a tenth of native's.
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(1100);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live.each(["2025-06-18", "2025-11-25"])(
  "negotiates stateful revision %s and serves the same catalog",
  (revision) =>
    Effect.gen(function* statefulRevision() {
      const origin = yield* servingMcpHttp();
      const { initialized, request } = yield* connectMcp(origin, revision);
      expect(
        Schema.decodeUnknownSync(Initialized)(initialized).result
          .protocolVersion
      ).toBe(revision);
      const { tools } = Schema.decodeUnknownSync(ToolList)(
        yield* request("tools/list", {})
      ).result;
      expect(tools.map((tool) => tool.name)).toContain("agent_run_start");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("answers an unknown revision with 2025-06-18", () =>
  Effect.gen(function* unknownRevision() {
    const origin = yield* servingMcpHttp();
    const { initialized } = yield* connectMcp(origin, "2024-01-01");
    expect(
      Schema.decodeUnknownSync(Initialized)(initialized).result.protocolVersion
    ).toBe("2025-06-18");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("serves stateless 2026-07-28 requests without initialize", () =>
  Effect.gen(function* statelessRevision() {
    const origin = yield* servingMcpHttp();
    const call = statelessMcp(origin);
    const listed = yield* call("tools/list", {});
    expect(listed.status).toBe(200);
    const { tools } = Schema.decodeUnknownSync(ToolList)(listed.body).result;
    expect(tools.map((tool) => tool.name)).toContain("agent_run_start");

    const catalog = yield* call(
      "tools/call",
      { arguments: {}, name: "agent_catalog_get" },
      "agent_catalog_get"
    );
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(catalog.body)).toContain('"isError":false');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
