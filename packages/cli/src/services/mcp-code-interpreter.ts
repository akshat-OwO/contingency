import {
  AgentPendingDecision,
  AgentSessionId,
  AndroidWorkspacePreparation,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import type { Types } from "effect";
import { AiError, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { CurrentLogLevel } from "effect/References";

import { AgentSession } from "./agent-session.ts";
import { AndroidWorkspace } from "./android-workspace.ts";
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
import { withStrictParameters } from "./mcp-strict-parameters.ts";

/**
 * The experimental single-tool interface (ADR 0059, #460). Opted into with
 * `CONTINGENCY_MCP_INTERFACE=single-tool`, it replaces every native tool with
 * `agent_code_execute`, which runs one program in a fresh OpenCode
 * interpreter process. Each native tool becomes an operation the program
 * calls as `tools.<name>(input)`, dispatched through the same strict handler
 * an MCP call reaches, so validation, Domain Scope, Confirmation, and
 * operation-id replay are exactly the native tools'.
 */

/** One native tool a program may call, bound to its handlers. */
export interface InterpreterOperationEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Json;
  readonly readOnly: boolean;
  readonly run: (input: Schema.Json) => Effect.Effect<DispatchOutcome>;
}

/**
 * Every operation the configured catalog offers. Each source layer adds its
 * toolkit's tools while the server is built, before any program runs.
 */
export type InterpreterOperationMap = Map<string, InterpreterOperationEntry>;
export const InterpreterOperations = Context.Service<InterpreterOperationMap>(
  "@contingency/InterpreterOperations"
);

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
  outcome: Schema.Literals(["succeeded", "failed", "rejected", "uncertain"]),
  sequence: Schema.Int,
});

const InterventionReason = Schema.Literals([
  "boundary",
  "pending_decision",
  "takeover",
  "user_control",
  "variable_requested",
  "device_preparation",
]);
type InterventionReasonName = typeof InterventionReason.Type;

/** Why a program ended so the user can act, and where they act. */
const Intervention = Schema.Struct({
  operation: Schema.String,
  /** The open decisions or device preparation steps, as the session has them. */
  pending: Schema.Array(Schema.Json),
  reasons: Schema.Array(InterventionReason),
  sessionId: Schema.String,
  viewUrl: Schema.optionalKey(Schema.String),
});
type InterventionValue = typeof Intervention.Type;
const decodeIntervention = Schema.decodeUnknownOption(Intervention);

const CodeExecuteResult = Schema.Struct({
  diagnostic: Schema.optionalKey(
    Schema.Struct({ kind: Schema.String, message: Schema.String })
  ),
  intervention: Schema.optionalKey(Intervention),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
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
  description: `Experimental. Run one JavaScript program in a fresh interpreter; no variable survives it, but Agent Sessions and Runs persist. Every Contingency tool is an async operation: \`await tools.agent_session_get({ sessionId })\`, with the same parameters, checks, and operationId replay. First run \`return search({ query: "browser act" })\` (also query, limit, offset; an empty query lists all) to read signatures, then call operations in a separate program. A Pending Decision, Takeover, Variable request, or device preparation ends the program before any later call and returns it with receipts; the user acts in the Workspace, then a new program resumes only that exact attempt. An uncertain receipt was stopped mid-dispatch: inspect the session or repeat its operationId. Screenshots return files, not bytes. Limits: timeoutMs ${INTERPRETER_LIMITS.minTimeoutMs}-${INTERPRETER_LIMITS.maxTimeoutMs} (default ${INTERPRETER_LIMITS.defaultTimeoutMs}), ${INTERPRETER_LIMITS.maxToolCalls} calls, ${INTERPRETER_LIMITS.maxOutputBytes} bytes of result.`,
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
const isString = Schema.is(Schema.String);

// Request services come from each MCP call, as Effect's own McpServer
// arranges, so verification elicitation reaches the client that asked.
const omitRequestServices = Context.omit(
  McpSchema.McpRequestContext,
  McpSchema.McpServerClient,
  HttpServerRequest.HttpServerRequest,
  CurrentLogLevel
);

/** Why a handler refused, in the words an MCP client would read. */
const refusalOf = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && AiError.isAiError(failure.value)) {
    return failure.value.reason.message.slice(0, 2000);
  }
  return Cause.pretty(cause).slice(0, 500);
};

/** Adds one toolkit's tools to the catalog's operations. */
export const collectOperations = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) =>
  Effect.gen(function* collect() {
    const operations = yield* InterpreterOperations;
    const built = yield* toolkit;
    const services = omitRequestServices(yield* Effect.context<never>());
    for (const [name, tool] of Object.entries(built.tools)) {
      operations.set(name, {
        description: Tool.getDescription(tool) ?? name,
        // SAFETY: a JSON Schema document is plain JSON.
        inputSchema: Tool.getJsonSchema(tool) as Schema.Json,
        name,
        readOnly: Context.get(tool.annotations, Tool.Readonly),
        run: (input) =>
          // SAFETY: the strict handler decodes `input` with the tool's own
          // schema before it runs, exactly as for an MCP call.
          built.handle(name, input as Tool.Parameters<Tools[string]>).pipe(
            Effect.flatMap(Stream.runLast),
            Effect.map((last): DispatchOutcome => {
              if (last._tag === "None" || !isJson(last.value.encodedResult)) {
                return {
                  message: "The operation answered nothing.",
                  ok: false,
                };
              }
              const encoded = last.value.encodedResult;
              if (last.value.isFailure) {
                return {
                  message: isString(encoded)
                    ? encoded
                    : JSON.stringify(encoded),
                  ok: false,
                };
              }
              return { ok: true, value: encoded };
            }),
            Effect.catchCause((cause) =>
              Effect.succeed<DispatchOutcome>({
                message: refusalOf(cause),
                ok: false,
              })
            ),
            // SAFETY: these handlers need only the services their layer was
            // built with, merged under the calling request's own services.
            Effect.provideContext(
              services as Context.Context<Tool.HandlerServices<Tools[string]>>
            )
          ),
      });
    }
  });

/** A toolkit offered as operations, with the handlers that serve it. */
export const operationSource = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>
) =>
  Layer.effectDiscard(collectOperations(toolkit)).pipe(Layer.provide(handlers));

const decodeSessionInput = Schema.decodeUnknownOption(
  Schema.Struct({ sessionId: AgentSessionId })
);
const decodeSessionResult = Schema.decodeUnknownOption(
  Schema.Struct({ id: AgentSessionId })
);
const ActionStop = Schema.Struct({
  intervention: Schema.optional(Schema.NullOr(Schema.Json)),
  stopped: Schema.optional(
    Schema.NullOr(Schema.Struct({ reason: Schema.String }))
  ),
});
const decodeActionStop = Schema.decodeUnknownOption(ActionStop);
const AndroidCommand = Schema.Struct({
  command: Schema.Struct({
    _tag: Schema.String,
    name: Schema.optional(Schema.String),
    sessionId: Schema.optional(AgentSessionId),
  }),
});
const decodeAndroidCommand = Schema.decodeUnknownOption(AndroidCommand);
const decodeAndroidResult = Schema.decodeUnknownOption(
  Schema.Struct({
    controller: AndroidWorkspaceSummary.fields.controller,
    id: AgentSessionId,
    preparation: Schema.Struct({
      pending: AndroidWorkspacePreparation.fields.pending,
    }),
    variables: Schema.optional(
      Schema.Array(
        Schema.Struct({ name: Schema.String, status: Schema.String })
      )
    ),
  })
);
const encodePendingDecisions = Schema.encodeUnknownOption(
  Schema.Array(AgentPendingDecision)
);

/** What in a browser session waits on the user, keyed by identity. */
const awaitingUser = (
  snapshot: AgentSessionSnapshot
): Map<string, InterventionReasonName> => {
  const waits = new Map<string, InterventionReasonName>();
  for (const decision of snapshot.pendingDecisions) {
    waits.set(`decision:${decision.pendingDecisionId}`, "pending_decision");
  }
  for (const variable of snapshot.setupVariables ?? []) {
    if (variable.status === "requested") {
      waits.set(`variable:${variable.requestId}`, "variable_requested");
    }
  }
  if (snapshot.takeover !== null) {
    waits.set(`takeover:${snapshot.takeover.requestedAt}`, "takeover");
  }
  if (snapshot.controller === "user") {
    waits.set("controller", "user_control");
  }
  return waits;
};

export const CodeInterpreterToolHandlersLive = CodeInterpreterTools.toLayer(
  Effect.gen(function* makeHandlers() {
    const catalog = yield* InterpreterOperations;
    const sessions = yield* AgentSession;
    // Present wherever Android is configured; the native catalog does not
    // require it either until an Android tool is called.
    const android = yield* Effect.serviceOption(AndroidWorkspace);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const readSession = (sessionId: AgentSessionId) =>
      sessions.get(sessionId).pipe(Effect.option);

    /**
     * Whether an Android command left its session waiting on the user. A
     * Variable request, preparation consent, or the user holding control all
     * end the program; Android has no Confirmation.
     */
    const androidIntervention = (
      input: Schema.Json,
      value: Schema.Json,
      before: Option.Option<typeof AndroidWorkspaceSummary.Type>
    ): InterventionValue | undefined => {
      const result = decodeAndroidResult(value);
      if (Option.isNone(result)) {
        return undefined;
      }
      const { controller, id, preparation, variables } = result.value;
      const command = decodeAndroidCommand(input);
      const reasons = new Set<InterventionReasonName>();
      const earlier = new Set(
        Option.match(before, {
          onNone: () => [],
          onSome: (summary) =>
            summary.preparation.pending.map((step) => step.id),
        })
      );
      if (preparation.pending.some((step) => !earlier.has(step.id))) {
        reasons.add("device_preparation");
      }
      const wasUser = Option.exists(
        before,
        (summary) => summary.controller === "user"
      );
      if (controller === "user" && !wasUser) {
        reasons.add("user_control");
      }
      if (
        Option.isSome(command) &&
        command.value.command._tag === "variable-request" &&
        (variables ?? []).some(
          (variable) =>
            variable.name === command.value.command.name &&
            variable.status === "requested"
        )
      ) {
        reasons.add("variable_requested");
      }
      return reasons.size === 0
        ? undefined
        : {
            operation: "agent_android_workspace",
            pending: preparation.pending,
            reasons: [...reasons],
            sessionId: id,
          };
    };

    /**
     * Dispatches one operation and decides whether it opened a user
     * intervention. A program may never act past one: the Pending Decision,
     * Takeover, or Variable request goes back to the agent instead.
     */
    const dispatch: InterpreterDispatch = (name, input) =>
      Effect.gen(function* dispatchOperation() {
        const operation = catalog.get(name);
        if (operation === undefined) {
          return {
            message: `${name} is not an operation this program may request.`,
            ok: false,
          } satisfies DispatchOutcome;
        }
        if (operation.readOnly) {
          return yield* operation.run(input);
        }
        if (name === "agent_android_workspace") {
          const sessionId = decodeAndroidCommand(input).pipe(
            Option.flatMap(({ command }) =>
              Option.fromNullishOr(command.sessionId)
            )
          );
          const before =
            Option.isSome(sessionId) && Option.isSome(android)
              ? yield* android.value.list().pipe(
                  Effect.map((summaries) =>
                    Option.fromNullishOr(
                      summaries.find(({ id }) => id === sessionId.value)
                    )
                  ),
                  Effect.orElseSucceed(() => Option.none())
                )
              : Option.none();
          const outcome = yield* operation.run(input);
          if (!outcome.ok) {
            return outcome;
          }
          const intervention = androidIntervention(
            input,
            outcome.value,
            before
          );
          return intervention === undefined
            ? outcome
            : { ...outcome, intervention };
        }
        const named = decodeSessionInput(input).pipe(
          Option.map(({ sessionId }) => sessionId)
        );
        const before = Option.isSome(named)
          ? yield* readSession(named.value)
          : Option.none();
        const outcome = yield* operation.run(input);
        if (!outcome.ok) {
          return outcome;
        }
        const sessionId = Option.orElse(named, () =>
          decodeSessionResult(outcome.value).pipe(Option.map(({ id }) => id))
        );
        if (Option.isNone(sessionId)) {
          return outcome;
        }
        const after = yield* readSession(sessionId.value);
        if (Option.isNone(after)) {
          return outcome;
        }
        const earlier = Option.match(before, {
          onNone: () => new Map<string, InterventionReasonName>(),
          onSome: awaitingUser,
        });
        const reasons = new Set<InterventionReasonName>();
        for (const [key, reason] of awaitingUser(after.value)) {
          if (!earlier.has(key)) {
            reasons.add(reason);
          }
        }
        const stop = decodeActionStop(outcome.value);
        if (
          Option.isSome(stop) &&
          ((stop.value.intervention ?? null) !== null ||
            stop.value.stopped?.reason === "intervention")
        ) {
          reasons.add("boundary");
        }
        if (reasons.size === 0) {
          return outcome;
        }
        const pending = encodePendingDecisions(after.value.pendingDecisions);
        return {
          ...outcome,
          intervention: {
            operation: name,
            pending: Option.match(pending, {
              onNone: () => [],
              onSome: (decisions) => (isJson(decisions) ? decisions : []),
            }),
            reasons: [...reasons],
            sessionId: sessionId.value,
            viewUrl: after.value.viewUrl,
          },
        } satisfies DispatchOutcome;
      });

    return CodeInterpreterTools.of({
      agent_code_execute: (params) => {
        // Signatures are rendered only for a program that searches them.
        const searches = params.code.includes("search");
        const operations: OfferedOperation[] = [...catalog.values()].map(
          (operation) =>
            searches
              ? {
                  description: operation.description,
                  inputSchema: operation.inputSchema,
                  name: operation.name,
                }
              : { description: "", name: operation.name }
        );
        return runInterpreterProgram({
          code: params.code,
          dispatch,
          operations,
          timeoutMs: params.timeoutMs ?? INTERPRETER_LIMITS.defaultTimeoutMs,
        }).pipe(
          Effect.map(({ intervention, ...outcome }) => {
            const result: Types.Mutable<typeof CodeExecuteResult.Type> = {
              ...outcome,
            };
            const decoded = decodeIntervention(intervention);
            if (Option.isSome(decoded)) {
              result.intervention = decoded.value;
            }
            return result;
          }),
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
        );
      },
    });
  })
);

/**
 * The single-tool catalog: `agent_code_execute` over every operation the
 * sources add. Resources and prompts are served beside it unchanged.
 */
export const makeMcpCodeInterpreterLayer = <E, R>(
  sources: Layer.Layer<never, E, R | InterpreterOperationMap>
) =>
  Layer.merge(
    McpServer.toolkit(CodeInterpreterTools).pipe(
      Layer.provide(CodeInterpreterToolHandlersLive)
    ),
    sources
  ).pipe(Layer.provide(Layer.sync(InterpreterOperations, () => new Map())));
