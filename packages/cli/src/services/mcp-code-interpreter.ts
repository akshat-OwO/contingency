import type { Context } from "effect";
import { Effect, Layer, Schema, Stream } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { ChildProcessSpawner } from "effect/process";

import type { OfferedOperation } from "./code-interpreter-protocol.ts";
import { MemoryUsage } from "./code-interpreter-protocol.ts";
import {
  INTERPRETER_LIMITS,
  runInterpreterProgram,
} from "./code-interpreter.ts";
import type {
  DispatchOutcome,
  InterpreterDispatch,
} from "./code-interpreter.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "./mcp-agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

/**
 * The OpenCode interpreter feasibility prototype (ADR 0059, #459), opt-in
 * and deliberately narrow: it proves the process boundary, limits, and
 * receipts with a session wait and a browser action, not every capability.
 * Each operation goes through the same strict handler an MCP call reaches,
 * so validation, Domain Scope, Confirmation, and operation-id receipts are
 * exactly the native tools'.
 */
export const INTERPRETER_OPERATIONS = [
  "agent_sessions_get",
  "agent_session_get",
  "agent_browser_snapshot",
  "agent_browser_act",
] as const;

// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.Error` is a class factory.
class CodeExecuteFailure extends Schema.Error<CodeExecuteFailure>(
  "CodeExecuteFailure"
)({
  code: Schema.String,
  message: Schema.String,
}) {}

const Receipt = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  operation: Schema.String,
  operationId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["succeeded", "failed", "rejected"]),
  sequence: Schema.Int,
});

const CodeExecuteResult = Schema.Struct({
  diagnostic: Schema.optionalKey(
    Schema.Struct({ kind: Schema.String, message: Schema.String })
  ),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  pendingDecision: Schema.optionalKey(Schema.Json),
  process: Schema.Struct({
    bytesFromInterpreter: Schema.Int,
    bytesToInterpreter: Schema.Int,
    durationMs: Schema.Number,
    exit: Schema.String,
    heapLimitBytes: Schema.NullOr(Schema.Number),
    lastMemory: Schema.NullOr(MemoryUsage),
    peakRssBytes: Schema.NullOr(Schema.Number),
    pid: Schema.Number,
    rssCeilingBytes: Schema.Number,
    startupMs: Schema.NullOr(Schema.Number),
  }),
  receipts: Schema.Array(Receipt),
  status: Schema.Literals([
    "completed",
    "program_failed",
    "intervention",
    "deadline_exceeded",
    "memory_limit",
    "crashed",
    "protocol_violation",
  ]),
  truncated: Schema.optionalKey(Schema.Boolean),
  value: Schema.optionalKey(Schema.Json),
});

const CodeExecuteTool = Tool.make("agent_code_execute", {
  description: `Experimental interpreter prototype. Runs one program in a fresh OpenCode interpreter process; no variable survives the execution, but Agent Sessions and Runs persist. First run \`return search({ query: "" })\` to read operation signatures, then run a separate program that awaits operations such as \`await tools.agent_session_get({ sessionId })\`. Operations: ${INTERPRETER_OPERATIONS.join(", ")}, with the same parameters, checks, and operation-id replay as the native tools. A Pending Decision ends the program and returns it with receipts for completed operations; resume natively. Limits: timeoutMs ${INTERPRETER_LIMITS.minTimeoutMs}-${INTERPRETER_LIMITS.maxTimeoutMs} (default ${INTERPRETER_LIMITS.defaultTimeoutMs}), ${INTERPRETER_LIMITS.maxToolCalls} calls, ${INTERPRETER_LIMITS.maxOutputBytes} bytes of result.`,
  failure: CodeExecuteFailure,
  parameters: Schema.Struct({
    code: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(INTERPRETER_LIMITS.codeCharacters)
    ),
    timeoutMs: Schema.optional(
      Schema.NullOr(
        Schema.Int.check(
          Schema.isBetween({
            maximum: INTERPRETER_LIMITS.maxTimeoutMs,
            minimum: INTERPRETER_LIMITS.minTimeoutMs,
          })
        )
      )
    ),
  }),
  success: CodeExecuteResult,
});

export const CodeInterpreterTools = withStrictParameters(
  Toolkit.make(CodeExecuteTool)
);

const isJson = Schema.is(Schema.Json);

const ActionIntervention = Schema.Struct({
  intervention: Schema.optional(Schema.NullOr(Schema.Json)),
});
const decodeIntervention = Schema.decodeUnknownOption(ActionIntervention);

/** The Pending Decision an action result opened, if it opened one. */
const pendingDecisionOf = (value: Schema.Json): Schema.Json | undefined => {
  const decoded = decodeIntervention(value);
  return decoded._tag === "Some"
    ? (decoded.value.intervention ?? undefined)
    : undefined;
};

export const CodeInterpreterToolHandlersLive = CodeInterpreterTools.toLayer(
  Effect.gen(function* makeHandlers() {
    const built = yield* AgentSessionTools;
    const services = yield* Effect.context<never>();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const allowed = new Set<string>(INTERPRETER_OPERATIONS);
    const operations: OfferedOperation[] = [];
    for (const [name, tool] of Object.entries(built.tools)) {
      if (allowed.has(name)) {
        operations.push({
          description: Tool.getDescription(tool) ?? name,
          // SAFETY: a JSON Schema document is plain JSON.
          inputSchema: Tool.getJsonSchema(tool) as Schema.Json,
          name,
        });
      }
    }

    const dispatch: InterpreterDispatch = (operation, input) =>
      // SAFETY: the strict handler decodes `input` with the tool's own schema
      // before it runs, exactly as for an MCP call.
      built.handle(operation as keyof typeof built.tools, input as never).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.map((last): DispatchOutcome => {
          if (last._tag === "None" || !isJson(last.value.encodedResult)) {
            return { message: "The operation answered nothing.", ok: false };
          }
          const encoded = last.value.encodedResult;
          if (last.value.isFailure) {
            return { message: JSON.stringify(encoded), ok: false };
          }
          const pendingDecision =
            operation === "agent_browser_act"
              ? pendingDecisionOf(encoded)
              : undefined;
          return { ok: true, pendingDecision, value: encoded };
        }),
        Effect.catchCause((cause) =>
          Effect.succeed<DispatchOutcome>({
            message: String(cause).slice(0, 500),
            ok: false,
          })
        ),
        // SAFETY: these handlers need only the services their layer was
        // built with, which is the context captured here.
        Effect.provideContext(
          services as Context.Context<
            Tool.HandlerServices<(typeof built.tools)[keyof typeof built.tools]>
          >
        )
      );

    return CodeInterpreterTools.of({
      agent_code_execute: (params) =>
        runInterpreterProgram({
          code: params.code,
          dispatch,
          operations,
          timeoutMs: params.timeoutMs ?? INTERPRETER_LIMITS.defaultTimeoutMs,
        }).pipe(
          Effect.mapError(
            (failure) =>
              new CodeExecuteFailure({
                code: "code_interpreter_unavailable",
                message: `The interpreter process could not run: ${failure.message}`,
              })
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner
          )
        ),
    });
  })
).pipe(Layer.provide(AgentSessionToolHandlersLive));

/** The opt-in interpreter prototype, registered only when enabled. */
export const McpCodeInterpreterLayer = McpServer.toolkit(
  CodeInterpreterTools
).pipe(Layer.provide(CodeInterpreterToolHandlersLive));
