import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify";
import { Context, Effect, Layer, Schema, Semaphore, Stream } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";
import type {
  QuickJSAsyncContext,
  QuickJSHandle,
} from "quickjs-emscripten-core";

import { AgentRunToolHandlersLive, AgentRunTools } from "./mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "./mcp-agent-session.ts";
import {
  AgentCatalogToolHandlersLive,
  AgentCatalogTools,
} from "./mcp-catalog.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import {
  TeachingRecordingToolHandlersLive,
  TeachingRecordingTools,
} from "./mcp-teaching-recording.ts";

/**
 * Sandboxed code orchestration, an opt-in experiment (ADR 0045).
 *
 * The agent sends a short script instead of paging and filtering data across
 * many model turns. The script runs in a QuickJS WebAssembly isolate with no
 * file system, network, timers, or Node API. Its only capability is
 * `contingency.call(name, params)`, which reaches Contingency's read-only MCP
 * tools through the same handlers, validation, and encoding as an MCP call.
 * Nothing it can call acts in a browser, writes a file, or resolves consent.
 */

export const CODE_MODE_LIMITS = {
  /** Read calls one script may make. */
  calls: 50,
  /** Characters of script source. */
  codeCharacters: 16_384,
  /** Default and maximum wall-clock budget, in milliseconds. */
  defaultTimeoutMs: 5000,
  maxTimeoutMs: 15_000,
  /** Bytes of isolate heap and stack. */
  memoryBytes: 32 * 1024 * 1024,
  /** Characters of JSON the script may return to the model. */
  resultCharacters: 16_384,
  stackBytes: 512 * 1024,
} as const;

// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.Error` is a class factory.
class CodeRunFailure extends Schema.Error<CodeRunFailure>("CodeRunFailure")({
  code: Schema.String,
  message: Schema.String,
}) {}

const refuse = (code: string, message: string) =>
  new CodeRunFailure({ code, message: `${message} (${code})` });

const CodeRunTool = Tool.make("agent_code_run", {
  description: `Run a short JavaScript function body in an isolated sandbox to page, join, filter, or count Contingency data without returning every intermediate row. The only capability is contingency.call(name, params), which calls a read-only Contingency tool such as agent_teaching_timeline_get, agent_session_history_get, agent_flow_skills_list, or open_run and returns its result synchronously; it throws on refusal. Return a JSON-serializable value. No browser action, file, network, timer, or consent is reachable. Limits: ${CODE_MODE_LIMITS.calls} calls, ${CODE_MODE_LIMITS.maxTimeoutMs} ms, ${CODE_MODE_LIMITS.resultCharacters} characters of result.`,
  failure: CodeRunFailure,
  parameters: Schema.Struct({
    code: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CODE_MODE_LIMITS.codeCharacters)
    ),
    timeoutMs: Schema.optional(
      Schema.NullOr(
        Schema.Int.check(
          Schema.isBetween({
            maximum: CODE_MODE_LIMITS.maxTimeoutMs,
            minimum: 100,
          })
        )
      )
    ),
  }),
  success: Schema.Struct({
    calls: Schema.Int,
    result: Schema.Unknown.annotate({
      description: "The script's return value.",
    }),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const CodeModeTools = withStrictParameters(Toolkit.make(CodeRunTool));

type Json = typeof Schema.Json.Type;

/** One read-only tool a script may call, already bound to its handlers. */
type ReadTool = (params: Json) => Effect.Effect<{
  readonly encoded: Json;
  readonly isFailure: boolean;
}>;

const isJson = Schema.is(Schema.Json);

/** Adds one toolkit's read-only tools to `into`, bound to its handlers. */
const collectReadOnly = <Tools extends Record<string, Tool.Any>>(
  built: Toolkit.WithHandler<Tools>,
  services: Context.Context<never>,
  into: Map<string, ReadTool>
) => {
  for (const [name, tool] of Object.entries(built.tools)) {
    if (!Context.get(tool.annotations, Tool.Readonly)) {
      continue;
    }
    into.set(name, (params) =>
      // SAFETY: the handler decodes `params` with the tool's own strict
      // schema before it runs, exactly as for an MCP call.
      built.handle(name, params as Tool.Parameters<Tools[string]>).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.map((last) =>
          last._tag === "Some" && isJson(last.value.encodedResult)
            ? {
                encoded: last.value.encodedResult,
                isFailure: last.value.isFailure,
              }
            : { encoded: "The tool answered nothing.", isFailure: true }
        ),
        Effect.catchCause((cause) =>
          Effect.succeed({
            encoded: String(cause).slice(0, 500),
            isFailure: true,
          })
        ),
        // SAFETY: these handlers need only the services their layers were
        // built with, which is the context captured here; McpServer provides
        // its handlers the same way.
        Effect.provideContext(
          services as Context.Context<Tool.HandlerServices<Tools[string]>>
        )
      )
    );
  }
};

/** Every read-only tool across Contingency's toolkits, by name. */
const readTools = Effect.gen(function* collectReadTools() {
  const tools = new Map<string, ReadTool>();
  const services = yield* Effect.context<never>();
  collectReadOnly(yield* AgentSessionTools, services, tools);
  collectReadOnly(yield* AgentCatalogTools, services, tools);
  collectReadOnly(yield* AgentRunTools, services, tools);
  collectReadOnly(yield* TeachingRecordingTools, services, tools);
  return tools;
});

/** What the bridge answers inside the sandbox: a result, or why it refused. */
type BridgeAnswer = { readonly error: string } | { readonly result: Json };

const PRELUDE = `
const contingency = Object.freeze({
  call(name, params) {
    const answer = JSON.parse(__contingencyCall(String(name), JSON.stringify(params ?? {})));
    if (answer.error !== undefined) {
      throw new Error(answer.error);
    }
    return answer.result;
  },
});
`;

const wasm = Effect.cached(
  Effect.promise(() => newQuickJSAsyncWASMModuleFromVariant(variant))
);

/** Reads a returned handle as JSON text, disposing it either way. */
const readResult = (context: QuickJSAsyncContext, handle: QuickJSHandle) => {
  try {
    return context.getString(handle);
  } finally {
    handle.dispose();
  }
};

export const CodeModeToolHandlersLive = CodeModeTools.toLayer(
  Effect.gen(function* makeHandlers() {
    const tools = yield* readTools;
    const services = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(services);
    // One QuickJS module allows a single suspended host call at a time.
    const gate = yield* Semaphore.make(1);
    const loadWasm = yield* wasm;
    return CodeModeTools.of({
      agent_code_run: (params) =>
        gate.withPermit(
          Effect.gen(function* runScript() {
            const quickjs = yield* loadWasm;
            const timeoutMs =
              params.timeoutMs ?? CODE_MODE_LIMITS.defaultTimeoutMs;
            const deadline = Date.now() + timeoutMs;
            let calls = 0;
            const outcome = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                // A context made by the module owns its runtime and frees it
                // on dispose. Disposing a separately made runtime fails to
                // free host function references in this QuickJS release.
                const context = quickjs.newContext();
                const { runtime } = context;
                runtime.setMemoryLimit(CODE_MODE_LIMITS.memoryBytes);
                runtime.setMaxStackSize(CODE_MODE_LIMITS.stackBytes);
                runtime.setInterruptHandler(
                  shouldInterruptAfterDeadline(deadline)
                );
                return context;
              }),
              (context) =>
                Effect.promise(async () => {
                  const call = context.newAsyncifiedFunction(
                    "__contingencyCall",
                    async (nameHandle, paramsHandle) => {
                      const answer = (body: BridgeAnswer) =>
                        context.newString(JSON.stringify(body));
                      calls += 1;
                      if (calls > CODE_MODE_LIMITS.calls) {
                        return answer({ error: "Call budget exhausted." });
                      }
                      if (Date.now() > deadline) {
                        return answer({ error: "Time budget exhausted." });
                      }
                      const name = context.getString(nameHandle);
                      const tool = tools.get(name);
                      if (tool === undefined) {
                        return answer({
                          error: `${name} is not a read-only Contingency tool.`,
                        });
                      }
                      const result = await run(
                        tool(JSON.parse(context.getString(paramsHandle)))
                      );
                      return answer(
                        result.isFailure
                          ? { error: JSON.stringify(result.encoded) }
                          : { result: result.encoded }
                      );
                    }
                  );
                  context.setProp(context.global, "__contingencyCall", call);
                  call.dispose();
                  const prelude = await context.evalCodeAsync(PRELUDE);
                  if (prelude.error !== undefined) {
                    prelude.error.dispose();
                    return { error: "The sandbox failed to start." };
                  }
                  prelude.value.dispose();
                  const evaluated = await context.evalCodeAsync(
                    `JSON.stringify((function () {\n${params.code}\n})() ?? null)`,
                    "agent-code.js"
                  );
                  if (evaluated.error !== undefined) {
                    const error = context.dump(evaluated.error);
                    evaluated.error.dispose();
                    return {
                      error:
                        Date.now() > deadline
                          ? "The script ran past its time budget."
                          : String(error?.message ?? error).slice(0, 1000),
                    };
                  }
                  return { json: readResult(context, evaluated.value) };
                }),
              (context) => Effect.sync(() => context.dispose())
            );
            if ("error" in outcome) {
              return yield* Effect.fail(
                refuse("code_run_failed", outcome.error)
              );
            }
            if (outcome.json.length > CODE_MODE_LIMITS.resultCharacters) {
              return yield* Effect.fail(
                refuse(
                  "code_run_result_too_large",
                  `The script returned ${outcome.json.length} characters; aggregate further and return at most ${CODE_MODE_LIMITS.resultCharacters}.`
                )
              );
            }
            return { calls, result: JSON.parse(outcome.json) };
          })
        ),
    });
  })
).pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionToolHandlersLive,
      AgentCatalogToolHandlersLive,
      AgentRunToolHandlersLive,
      TeachingRecordingToolHandlersLive
    )
  )
);

/** The opt-in sandboxed code tool, registered only when enabled. */
export const McpCodeModeLayer = McpServer.toolkit(CodeModeTools).pipe(
  Layer.provide(CodeModeToolHandlersLive)
);
