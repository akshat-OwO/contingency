import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  MCP_INSTRUCTIONS,
  makeMcpInstructions,
} from "../../src/services/mcp-http.ts";
import { makeSettingsProvider } from "../../src/services/settings.ts";
import { resolveSystemOne } from "../../src/services/system-one-discovery.ts";
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

it.live("keeps the sole emitted tool inside its byte budget", () =>
  Effect.gen(function* catalogBudget() {
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    const { tools } = Schema.decodeUnknownSync(ToolList)(
      yield* request("tools/list", {})
    ).result;
    expect(tools.map(({ name }) => name)).toEqual(["agent_code_execute"]);
    expect(bytes(tools)).toBeLessThanOrEqual(12_000);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    expect(
      yield* request("tools/call", {
        arguments: {},
        name: "agent_sessions_get",
      })
    ).toMatchObject({
      error: { code: -32_602, message: "Tool 'agent_sessions_get' not found" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const systemOne = {
  apiKey: Option.none(),
  first: false,
  model: "jev-latest",
  url: "http://127.0.0.1:8009/v1/systemone",
};

it("tells the agent to try a Pursuit first only under the experimental flag", () => {
  const program = makeMcpInstructions(false, { ...systemOne, first: true });
  expect(program).toContain("Try tools.agent_browser_pursue for each");
  expect(makeMcpInstructions(false, systemOne)).not.toContain("pursue");
});

it("builds distinct channel instructions", () => {
  const channel = makeMcpInstructions(true);
  expect(channel).not.toBe(MCP_INSTRUCTIONS);
  expect(channel).toContain(
    "meta.sessionId and meta.eventCursor as afterCursor"
  );
  expect(channel).toContain("Otherwise wait with afterCursor and waitMs");
  expect(channel.length).toBeLessThan(1250);
});

it.live("sends the context-saving habits as server instructions", () =>
  Effect.gen(function* serverInstructions() {
    const origin = yield* servingMcpHttp();
    const { initialized } = yield* connectMcp(origin);
    const decoded = Schema.decodeUnknownSync(Initialized)(initialized);
    expect(decoded.result.instructions).toBe(MCP_INSTRUCTIONS);
    expect(MCP_INSTRUCTIONS).toBe(makeMcpInstructions(false));
    // The single tool carries the habits its one schema cannot, and the #461
    // evaluation measured this text; its catalog is a tenth of native's. The
    // getting-started pointer (ADR 0069) adds one sentence to that text.
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(1150);
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
      expect(tools.map((tool) => tool.name)).toEqual(["agent_code_execute"]);
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
    expect(tools.map((tool) => tool.name)).toEqual(["agent_code_execute"]);

    const catalog = yield* call(
      "tools/call",
      {
        arguments: { code: "return await tools.agent_catalog_get({})" },
        name: "agent_code_execute",
      },
      "agent_code_execute"
    );
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(catalog.body)).toContain('"isError":false');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "leaves catalog and instructions byte-identical without an installation",
  () =>
    Effect.gen(function* noInstallation() {
      const absent = yield* resolveSystemOne(
        makeSettingsProvider({ env: {} }),
        { status: Effect.sync((): undefined => undefined) },
        {
          ensureStarted: Effect.die("must not start"),
          awaitReady: () => Effect.die("must not wait"),
        }
      );
      const readTools = (origin: string) =>
        Effect.gen(function* tools() {
          const client = yield* connectMcp(origin);
          return Schema.decodeUnknownSync(ToolList)(
            yield* client.request("tools/list", {})
          ).result.tools;
        });
      const baseline = yield* readTools(yield* servingMcpHttp());
      const discovered = yield* readTools(
        yield* servingMcpHttp(absent === undefined ? {} : { systemOne: absent })
      );
      expect(JSON.stringify(discovered)).toBe(JSON.stringify(baseline));
      expect(makeMcpInstructions(false, absent)).toBe(
        makeMcpInstructions(false)
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
