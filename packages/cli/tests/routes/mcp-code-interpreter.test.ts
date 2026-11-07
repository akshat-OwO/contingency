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

/** The supported operation contract stays available inside programs. */
const coverage = (options: Options) =>
  Effect.gen(function* inspectCatalog() {
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
      offered: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
        searched?.value
      ).toSorted(),
    };
  });

it.live(
  "offers all supported operations through the sole tool, keeping resources and prompts",
  () =>
    live(
      Effect.gen(function* everyCapability() {
        const base = yield* coverage({});
        expect(base.listed).toEqual(["agent_code_execute"]);
        expect(base.offered).toEqual([
          "agent_browser_act",
          "agent_browser_act_sequence",
          "agent_browser_devtools",
          "agent_browser_resume",
          "agent_browser_screenshot",
          "agent_browser_snapshot",
          "agent_catalog_get",
          "agent_catalog_select",
          "agent_device_sessions_list",
          "agent_device_workspace",
          "agent_flow_decide",
          "agent_flow_document_get",
          "agent_flow_dry_run_start",
          "agent_flow_run_start",
          "agent_flow_save",
          "agent_flows_list",
          "agent_guided_run_question_ask",
          "agent_guided_run_start",
          "agent_pending_decision_resolve",
          "agent_run_assess",
          "agent_run_complete",
          "agent_run_finding",
          "agent_run_scan",
          "agent_run_scan_scope",
          "agent_run_start",
          "agent_run_update",
          "agent_session_close",
          "agent_session_get",
          "agent_session_history_get",
          "agent_session_start",
          "agent_session_takeover_request",
          "agent_sessions_get",
          "agent_teaching_instruction_record",
          "agent_teaching_keyframe_get",
          "agent_teaching_recording_claim",
          "agent_teaching_recording_discard",
          "agent_teaching_recordings_list",
          "agent_teaching_setup_handoff",
          "agent_teaching_timeline_get",
          "agent_variable_enter",
          "agent_variable_request",
          "docs_get",
          "open_run",
        ]);
        const demo = yield* coverage({ demo: true });
        expect(demo.offered).toEqual(
          [...base.offered, "agent_example_run_start"].toSorted()
        );
        const pursuit = yield* coverage({ systemOne: SYSTEM_ONE });
        expect(pursuit.offered).toEqual(
          [...base.offered, "agent_browser_pursue"].toSorted()
        );
        const single = yield* singleTool({ demo: true });
        const { resources } = Schema.decodeUnknownSync(Listed)(
          yield* single.request("resources/list", {})
        ).result;
        expect(resources?.map(({ uri }) => uri)).toContain(
          "contingency://docs/settings"
        );
        const { prompts } = Schema.decodeUnknownSync(Listed)(
          yield* single.request("prompts/list", {})
        ).result;
        expect(prompts?.length).toBeGreaterThan(0);
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
  "dispatches an operation through its shared handler",
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
            await refused(() => tools.agent_device_workspace({ platform: "android", command: { _tag: "observe" } })),
            await refused(() => tools.agent_device_workspace({ platform: "android",
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

it.live.each(["android", "ios"] as const)(
  "returns a %s refusal without leaking a stack",
  (platform) =>
    live(
      Effect.gen(function* refusal() {
        const answer = yield* execute(`
      try { await tools.agent_device_workspace({ platform: ${JSON.stringify(platform)}, command: { _tag: "read", sessionId: "agent-device-missing" } }); }
      catch (error) { return error.message; }
    `);
        const message = Schema.decodeUnknownSync(Schema.String)(
          answer.structuredContent?.value
        );
        expect(message).toContain(
          "Device Workspace is unavailable in this process."
        );
        expect(message).not.toContain("    at ");
        expect(answer.structuredContent?.receipts[0]?.message).toBe(message);
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

it.live(
  "dispatches confirmed recording discard and refuses missing confirmation",
  () =>
    live(
      Effect.gen(function* discardDispatch() {
        const answer = yield* execute(`
      return await tools.agent_teaching_recording_discard({ recordingId: "missing-recording", operationId: "discard-missing", userConfirmed: true });
    `);
        expect(answer.structuredContent?.receipts).toEqual([
          expect.objectContaining({
            operation: "agent_teaching_recording_discard",
            outcome: "failed",
          }),
        ]);
        const refused = yield* execute(
          `return await tools.agent_teaching_recording_discard({ recordingId: "missing-recording", operationId: "discard-unconfirmed", userConfirmed: false });`
        );
        expect(refused.structuredContent?.status).not.toBe("completed");
      })
    ),
  HANG_GUARD_MS
);
