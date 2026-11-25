import { createServer } from "node:http";

import { AgentSessionId } from "@contingency/protocol";
import type {
  AgentActionIntent,
  AgentBrowserAction,
  AgentSessionCompact,
} from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  flow,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { Toolkit } from "effect/ai";
import type { Tool } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";

import { AgentSession } from "../../src/services/agent-session.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import type { AndroidWorkspaceService } from "../../src/services/android-workspace.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import type { IosWorkspaceService } from "../../src/services/ios-workspace.ts";
import { AgentRunTools } from "../../src/services/mcp-agent-run.ts";
import { AgentSessionTools } from "../../src/services/mcp-agent-session.ts";
import { AgentCatalogTools } from "../../src/services/mcp-catalog.ts";
import {
  androidIntervention,
  newBrowserWaits,
} from "../../src/services/mcp-code-interpreter.ts";
import { DeviceWorkspaceTools } from "../../src/services/mcp-device-workspace.ts";
import { makeMcpHttpLayer } from "../../src/services/mcp-http.ts";
import { OnboardingTools } from "../../src/services/mcp-onboarding.ts";
import { TeachingRecordingTools } from "../../src/services/mcp-teaching-recording.ts";
import { compactMcpValue } from "../../src/services/mcp-value.ts";
import { connectMcp } from "../helpers/mcp-http.ts";
import type { JsonValue } from "../helpers/mcp-http.ts";
import {
  agentProcessLayer,
  callParameters,
  declaredFailure,
  hasParameter,
  readPublished,
} from "./agent-process.ts";
import type {
  NativeWorkspaceDependencies,
  Readable,
  ToolFailure,
} from "./agent-process.ts";
import { performUserAction } from "./scripted-user.ts";
import {
  answeredValues,
  failureCodeOf,
  isJsonObject,
  makeScript,
  outcomeOf,
  RECORD_TRANSCRIPTS,
  resolveTokens,
  Script,
  substitute,
  UserAction,
  writeTranscript,
} from "./transcript.ts";
import type { Adapter, Recorder, Transcript } from "./transcript.ts";

/**
 * The Scripted Agent: a test driver that plays the external agent. Each step
 * is an Effect value with two renderings. The in-process adapter runs the
 * step's operations through the agent's toolkits; the HTTP adapter renders it
 * to one `agent_code_execute` program, which finds its target by role and
 * name inside the program. See `docs/agents/testing.md#the-scripted-agent`.
 */

/** The operations every process serves, which the in-process adapter calls. */
const ProcessTools = Toolkit.merge(
  AgentSessionTools,
  AgentCatalogTools,
  AgentRunTools,
  TeachingRecordingTools,
  DeviceWorkspaceTools
);

/**
 * Every operation the Scripted Agent calls, typed as the agent's toolkits
 * declare it. The demo store's operations run only over HTTP, on a process
 * built with `demo`.
 */
const AgentTools = Toolkit.merge(ProcessTools, OnboardingTools);

const servedByEveryProcess = (
  operation: string
): operation is keyof (typeof ProcessTools)["tools"] & string =>
  Predicate.hasProperty(ProcessTools.tools, operation);
type AgentTool = (typeof AgentTools)["tools"];
export type OperationName = keyof AgentTool & string;

/** A control the agent finds in the Browser Snapshot by role and accessible name. */
export interface Target {
  readonly name: string;
  readonly role: string;
}

/** One thing the Scripted Agent does, before an adapter renders it. */
export interface Step {
  readonly input: Schema.JsonObject;
  readonly operation: OperationName;
  /** The control whose ref goes at `field` of the input. */
  readonly target?:
    | { readonly control: Target; readonly field: readonly string[] }
    | undefined;
}

/** What `agent_code_execute` answers, as a test reads it. */
export const CodeExecution = Schema.Struct({
  diagnostic: Schema.optional(
    Schema.Struct({ kind: Schema.String, message: Schema.String })
  ),
  intervention: Schema.optional(
    Schema.Struct({
      operation: Schema.String,
      pending: Schema.Array(Schema.Json),
      reasons: Schema.Array(Schema.String),
      sessionId: Schema.String,
      viewUrl: Schema.optionalKey(Schema.String),
    })
  ),
  receipts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(Schema.String),
        operation: Schema.String,
        operationId: Schema.NullOr(Schema.String),
        outcome: Schema.String,
      })
    )
  ),
  status: Schema.String,
  value: Schema.optional(Schema.Json),
  valueResource: Schema.optional(Schema.Struct({ uri: Schema.String })),
});
export type CodeExecution = typeof CodeExecution.Type;

const ToolCall = Schema.Struct({
  result: Schema.Struct({ structuredContent: CodeExecution }),
});
const ResourceRead = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
});

/** How a program ended, read from an `agent_code_execute` response body. */
export const codeExecutionOf = flow(
  Schema.decodeUnknownSync(ToolCall),
  (toolCall) => toolCall.result.structuredContent
);

/** A JSON-RPC caller bound to one MCP session, over any transport. */
export type McpRequest = (
  method: string,
  params: { readonly [key: string]: JsonValue }
) => Effect.Effect<unknown>;

/**
 * Runs one program through `agent_code_execute` and answers with how it
 * ended. A value too large to return inline is read back from its resource.
 */
export const executeProgram =
  (request: McpRequest) => (code: string, timeoutMs?: number) =>
    Effect.gen(function* executeCode() {
      const body = yield* request("tools/call", {
        arguments: timeoutMs === undefined ? { code } : { code, timeoutMs },
        name: "agent_code_execute",
      });
      const decoded = Schema.decodeUnknownOption(ToolCall)(body);
      if (Option.isNone(decoded)) {
        return yield* Effect.die(
          `agent_code_execute answered ${JSON.stringify(body)}`
        );
      }
      const execution = decoded.value.result.structuredContent;
      if (execution.valueResource === undefined) {
        return execution;
      }
      const read = Schema.decodeUnknownSync(ResourceRead)(
        yield* request("resources/read", {
          uri: execution.valueResource.uri,
        })
      );
      const [resource] = read.result.contents;
      if (resource === undefined) {
        return yield* Effect.die("The value resource held no contents.");
      }
      const value = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Json)
      )(resource.text);
      return { ...execution, value };
    });

const accessor = (field: readonly string[]) =>
  field.map((key) => `[${JSON.stringify(key)}]`).join("");

/** The HTTP rendering of a step: one program, which finds its own target. */
export const renderProgram = ({
  input,
  operation,
  target,
}: Omit<Step, "operation"> & { readonly operation: string }) => {
  const declared = `const input = ${JSON.stringify(input)};`;
  const called = `return await tools.${operation}(input);`;
  if (target === undefined) {
    return [declared, called].join("\n");
  }
  return [
    declared,
    `const role = ${JSON.stringify(target.control.role)};`,
    `const name = ${JSON.stringify(target.control.name)};`,
    'const page = await tools.agent_browser_snapshot({ format: "structured", sessionId: input.sessionId });',
    "const nodes = page.nodes ?? [];",
    "const control = nodes.find((node) => node.role === role && node.name === name) ?? nodes.find((node) => node.role === role && node.name.includes(name));",
    "if (control === undefined) {",
    '  throw new Error("The Browser Snapshot had no " + role + " named " + name + ".");',
    "}",
    `input${accessor(target.field)} = control.ref;`,
    called,
  ].join("\n");
};

/** A program that calls one operation, as an agent writes it. */
export const operationProgram = (
  operation: string,
  input: { readonly [key: string]: JsonValue }
) => renderProgram({ input, operation });

/** The control the agent means: an exact name first, then one that contains it. */
const findControl = (
  nodes: readonly {
    readonly name: string;
    readonly ref: string;
    readonly role: string;
  }[],
  { name, role }: Target
) =>
  nodes.find((node) => node.role === role && node.name === name) ??
  nodes.find((node) => node.role === role && node.name.includes(name));

const withField = (
  input: Schema.JsonObject,
  [head, ...rest]: readonly string[],
  value: string
): Schema.JsonObject => {
  if (head === undefined) {
    return input;
  }
  const current = input[head];
  const parent = current !== undefined && isJsonObject(current) ? current : {};
  return {
    ...input,
    [head]: rest.length === 0 ? value : withField(parent, rest, value),
  };
};

/**
 * What the agent reads from one operation's success: its JSON, with a full
 * session view.
 */
export type AgentSuccess<Name extends OperationName> =
  unknown extends Tool.SuccessEncoded<AgentTool[Name]>
    ? Tool.Success<AgentTool[Name]>
    : Exclude<
        Readable<Tool.SuccessEncoded<AgentTool[Name]>>,
        typeof AgentSessionCompact.Encoded
      >;

/**
 * An operation's value as the agent reads it, in either adapter: the tool's
 * encoded success, with the fields it publishes as `unknown` decoded. A tool
 * that publishes its whole success as `unknown` is read with its own schema.
 */
const readValue = <Name extends OperationName>(
  operation: Name,
  value: Schema.Json
) => {
  const { successSchema } = AgentTools.tools[operation];
  const published = Schema.toEncoded(successSchema);
  return Schema.decodeUnknownEffect(
    published.ast._tag === "Unknown" ? successSchema : published
  )(value).pipe(
    Effect.flatMap((success) => readPublished(operation, success)),
    Effect.orDie,
    // SAFETY: the encoded success schema reads this tool's answer, and
    // `readPublished` decodes exactly the fields `Readable` names.
    Effect.map((success) => success as AgentSuccess<Name>)
  );
};

/** The objective the agent states, which the compact projection omits. */
const objectiveOf = ({ intent }: Schema.JsonObject) => {
  if (intent === undefined || !isJsonObject(intent)) {
    return;
  }
  const { objective } = intent;
  return Predicate.isString(objective) ? objective : undefined;
};

/**
 * An operation that started a session which already waits on the user: the
 * program ends before it can return, so the agent learns only the session
 * and why. The code is the Scripted Agent's, not Contingency's.
 */
const intervened = (
  reasons: readonly string[],
  sessionId: string
): ToolFailure => ({
  code: "intervention",
  intervention: { reasons, sessionId },
  message: `The program ended for the user: ${reasons.join(", ")}.`,
});

/** The session a start answers with, as the interpreter reads it. */
const startedSession = (value: Schema.Json) => {
  if (!isJsonObject(value)) {
    return;
  }
  const { id, session } = value;
  if (Predicate.isString(id)) {
    return id;
  }
  if (session === undefined || !isJsonObject(session)) {
    return;
  }
  const { id: sessionId } = session;
  return Predicate.isString(sessionId) ? sessionId : undefined;
};

/** How a program's ending reads as an operation's result or failure. */
const settle = (
  execution: CodeExecution
): Effect.Effect<Schema.Json, ToolFailure> => {
  if (execution.status === "completed") {
    return Effect.succeed(execution.value ?? null);
  }
  const { diagnostic } = execution;
  const failed =
    diagnostic?.kind === "ToolFailure"
      ? failureCodeOf(diagnostic.message)
      : undefined;
  if (diagnostic !== undefined && failed?.["code"] !== undefined) {
    return Effect.fail({
      code: failed["code"],
      failureReference: failed["reference"],
      message: diagnostic.message,
    });
  }
  return Effect.die(
    `The program ended ${execution.status}: ${diagnostic?.message ?? JSON.stringify(execution.intervention)}`
  );
};

/**
 * How a program that calls `operation` reads as its result or failure. When
 * the operation leaves its session waiting on the user, the program ends
 * before it returns, so a new program repeats the same operation id, as an
 * agent does, and reads the recorded result. A start's session was never
 * seen, so that program ends too.
 */
const settleOperation = (
  send: Effect.Effect<CodeExecution>,
  operation: string
) =>
  Effect.gen(function* settleProgram() {
    const execution = yield* send;
    if (execution.intervention?.operation !== operation) {
      return yield* settle(execution);
    }
    const repeated = yield* send;
    return repeated.intervention === undefined
      ? yield* settle(repeated)
      : yield* Effect.fail(
          intervened(
            repeated.intervention.reasons,
            repeated.intervention.sessionId
          )
        );
  });

/**
 * The single tool on an MCP session the test opened itself, such as a server
 * with the demo store or a child process over stdio. Each call is one
 * program, as an agent writes it.
 */
export const mcpProgram = (request: McpRequest) => {
  const execute = executeProgram(request);
  const executeOperation = (
    operation: string,
    input: { readonly [key: string]: JsonValue }
  ) => execute(operationProgram(operation, input));
  return {
    /** Calls one operation; a refusal fails with its ToolFailure. */
    call: (operation: string, input: { readonly [key: string]: JsonValue }) =>
      settleOperation(executeOperation(operation, input), operation),
    /** Runs a program and answers with how it ended. */
    execute,
    /** Runs a program that calls one operation and answers with how it ended. */
    executeOperation,
  };
};

/** Runs one step on the adapter its process was built with. */
export class ScriptedAgent extends Context.Service<
  ScriptedAgent,
  { readonly run: (step: Step) => Effect.Effect<Schema.Json, ToolFailure> }
>()("@contingency/tests/ScriptedAgent") {}

const inProcessAgent = Layer.effect(
  ScriptedAgent,
  Effect.gen(function* makeInProcessAgent() {
    const handlers = yield* ProcessTools;
    const sessions = yield* AgentSession;
    const android = yield* Effect.serviceOption(AndroidWorkspace);
    const ios = yield* Effect.serviceOption(IosWorkspace);
    /** The tool's answer as the agent reads it: encoded, then compacted. */
    const handle = (
      operation: OperationName,
      input: Schema.JsonObject
    ): Effect.Effect<Schema.Json, ToolFailure> => {
      if (!servedByEveryProcess(operation)) {
        return Effect.die(
          `${operation} runs only over HTTP, on a demo process.`
        );
      }
      // SAFETY: the handler decodes `input` with the tool's own parameters
      // schema, exactly as an MCP call does; its encoded result is JSON; and
      // each handler layer holds the services its tools depend on.
      return handlers.handle(operation, input as never).pipe(
        Effect.orDie,
        Effect.flatMap(Stream.runCollect),
        declaredFailure,
        Effect.mapError((failure): ToolFailure => failure),
        Effect.flatMap((results) => {
          const last = results.at(-1);
          // SAFETY: a tool's encoded result is JSON.
          return last === undefined
            ? Effect.die(`The ${operation} tool answered nothing.`)
            : Effect.succeed(
                compactMcpValue(
                  last.encodedResult as Schema.Json,
                  objectiveOf(input)
                )
              );
        })
      ) as Effect.Effect<Schema.Json, ToolFailure>;
    };
    return ScriptedAgent.of({
      run: ({ input, operation, target }) =>
        Effect.gen(function* runInProcess() {
          if (operation === "agent_device_workspace") {
            const rawCommand = input["command"];
            const command =
              rawCommand !== undefined && isJsonObject(rawCommand)
                ? rawCommand
                : undefined;
            const deviceSessionId = Predicate.isString(command?.["sessionId"])
              ? command["sessionId"]
              : undefined;
            const selected =
              input["platform"] === "ios"
                ? Option.getOrUndefined(ios)
                : Option.getOrUndefined(android);
            const before = yield* Effect.gen(function* readBefore() {
              if (deviceSessionId === undefined || selected === undefined) {
                return Option.none();
              }
              const summaries = yield* selected.list();
              return Option.fromNullishOr(
                summaries.find(({ id }) => id === deviceSessionId)
              );
            }).pipe(Effect.orElseSucceed(() => Option.none()));
            const value = yield* handle(operation, input);
            const intervention = androidIntervention(input, value, before);
            return intervention === undefined
              ? value
              : yield* Effect.fail(
                  intervened(intervention.reasons, intervention.sessionId)
                );
          }
          if (target === undefined && Predicate.isString(input["sessionId"])) {
            return yield* handle(operation, input);
          }
          if (target === undefined) {
            // A program ends when an operation leaves a session it had not
            // seen waiting on the user, as a start that requests a Variable
            // does, so the agent never reads that start's answer.
            const value = yield* handle(operation, input);
            const sessionId = startedSession(value);
            if (sessionId === undefined) {
              return value;
            }
            const started = yield* sessions
              .get(AgentSessionId.make(sessionId))
              .pipe(Effect.option);
            const reasons = Option.isSome(started)
              ? newBrowserWaits(Option.none(), started.value)
              : new Set<string>();
            return reasons.size === 0
              ? value
              : yield* Effect.fail(intervened([...reasons], sessionId));
          }
          const page = yield* readValue(
            "agent_browser_snapshot",
            yield* handle("agent_browser_snapshot", {
              format: "structured",
              sessionId: input["sessionId"] ?? null,
            })
          );
          const control = findControl(page.nodes ?? [], target.control);
          if (control === undefined) {
            return yield* Effect.die(
              `The Browser Snapshot had no ${target.control.role} named ${target.control.name}.`
            );
          }
          return yield* handle(
            operation,
            withField(input, target.field, control.ref)
          );
        }),
    });
  })
);

/**
 * Serves the single MCP tool over this process's services, on a free port.
 * With `demo`, it also serves the demo store and its operations, as
 * `contingency mcp --demo` does.
 */
const servedMcp = (demo: boolean) =>
  HttpRouter.serve(
    makeMcpHttpLayer(
      new Set(["http://127.0.0.1:7777"]),
      demo ? { demoSite: makeDemoSiteLayer() } : {}
    )
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
    )
  );
const mcpServer = servedMcp(false);

/** Opens an MCP session on the served tool and runs programs through it. */
const connectToMcp = Effect.gen(function* connectToServedMcp() {
  const { address } = yield* HttpServer.HttpServer;
  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die("Expected a TCP server.");
  }
  const { request } = yield* connectMcp(`http://127.0.0.1:${address.port}`);
  return executeProgram(request);
});

const httpAgent = (recorder: Recorder, demo: boolean) =>
  Layer.effect(
    ScriptedAgent,
    Effect.gen(function* makeHttpAgent() {
      const execute = yield* connectToMcp;
      return ScriptedAgent.of({
        run: (step) =>
          Effect.gen(function* runOverHttp() {
            const code = renderProgram({
              ...step,
              input: recorder.tokenize(step.input),
            });
            const send = Effect.map(
              execute(recorder.live(code)),
              (execution) => {
                recorder.program(code, execution);
                return execution;
              }
            );
            return yield* settleOperation(send, step.operation);
          }),
      });
    })
  ).pipe(Layer.provide(servedMcp(demo)));

/**
 * One MCP process over a Catalog Root with the Scripted Agent attached, on
 * the journey's adapter. Build it again to restart the process. A `demo`
 * process also serves the demo store, whose operations run only over HTTP.
 */
export const scriptedProcess = <
  A extends AndroidWorkspaceService = never,
  I extends IosWorkspaceService = never,
>(
  root: string,
  {
    androidWorkspace,
    demo = false,
    iosWorkspace,
    ...options
  }: Omit<
    NonNullable<globalThis.Parameters<typeof agentProcessLayer>[1]>,
    "androidWorkspace" | "iosWorkspace"
  > & {
    readonly androidWorkspace?:
      | Layer.Layer<A, never, NativeWorkspaceDependencies>
      | undefined;
    readonly demo?: boolean;
    readonly iosWorkspace?:
      | Layer.Layer<I, never, NativeWorkspaceDependencies>
      | undefined;
  } = {}
) =>
  Layer.unwrap(
    Script.useSync((script) => {
      script.recorder.process();
      const process = agentProcessLayer(root, {
        ...options,
        androidWorkspace,
        iosWorkspace,
      });
      return script.adapter === "http"
        ? httpAgent(script.recorder, demo).pipe(Layer.provideMerge(process))
        : inProcessAgent.pipe(Layer.provideMerge(process));
    })
  );

/** Parameters as the agent writes them, with an operation id it may omit. */
type Minted<Params> = Params extends { readonly operationId: string }
  ? Omit<Params, "operationId"> & {
      readonly operationId?: string | undefined;
    }
  : Params;

type Parameters<Name extends OperationName> = Minted<
  Tool.ParametersEncoded<AgentTool[Name]>
>;

/** The input a step sends: a minted operation id and the test defaults. */
const prepare = <Params>(operation: OperationName, params: Params) =>
  Script.useSync((script) => {
    const named =
      Predicate.hasProperty(params, "operationId") &&
      params.operationId !== undefined;
    const input =
      named || !hasParameter(AgentTools, operation, "operationId")
        ? params
        : { ...params, operationId: script.mint() };
    // SAFETY: operation parameters are plain JSON objects.
    return callParameters(AgentTools, operation, input) as Schema.JsonObject;
  });

const runStep = <Name extends OperationName, Params>(
  operation: Name,
  params: Params,
  target?: Step["target"]
) =>
  Effect.gen(function* runScriptedStep() {
    const agent = yield* ScriptedAgent;
    const input = yield* prepare(operation, params);
    const result = yield* agent.run({ input, operation, target });
    return yield* readValue(operation, result);
  });

/**
 * Calls one operation as the agent does. An omitted operation id is minted,
 * and a structured failure is raised so a test asserts on it with `flip`.
 */
export const call = <Name extends OperationName>(
  operation: Name,
  params: Parameters<Name>
) => runStep(operation, params);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A browser action aimed at a control, before its ref is known. */
export type TargetAction = DistributiveOmit<
  Extract<typeof AgentBrowserAction.Encoded, { readonly ref: unknown }>,
  "ref"
>;

/** Acts on the control the agent finds by role and name. */
export const act = (
  sessionId: string,
  control: Target,
  action: TargetAction,
  options: {
    readonly intent?: typeof AgentActionIntent.Encoded;
    readonly operationId?: string;
  } = {}
) =>
  runStep(
    "agent_browser_act",
    { ...options, action, sessionId },
    { control, field: ["action", "ref"] }
  );

/** Enters a runtime Variable into the control the agent finds by role and name. */
export const enterVariable = (
  sessionId: string,
  control: Target,
  name: string,
  options: {
    readonly flowName?: string;
    readonly operationId?: string;
  } = {}
) =>
  runStep(
    "agent_variable_enter",
    { ...options, name, sessionId },
    { control, field: ["ref"] }
  );

/** Waits on Session Events until the session satisfies the next assertion. */
export const awaitSession = (
  sessionId: string,
  until: (session: AgentSuccess<"agent_session_get">) => boolean
) =>
  Effect.gen(function* awaitSessionState() {
    let session = yield* call("agent_session_get", { sessionId });
    while (!until(session)) {
      const afterCursor = session.eventCursor;
      if (afterCursor === undefined || afterCursor === null) {
        return yield* Effect.die("The Agent Session returned no event cursor.");
      }
      // A cursor wait answers with compact state, so `until` reads the full
      // session the agent fetches next.
      const agent = yield* ScriptedAgent;
      yield* agent.run({
        input: yield* prepare("agent_session_get", { afterCursor, sessionId }),
        operation: "agent_session_get",
      });
      session = yield* call("agent_session_get", { sessionId });
    }
    return session;
  }).pipe(Effect.timeout("30 seconds"));

/**
 * Opens Teaching the way an agent does, then hands the browser straight to
 * the user who demonstrates the journey
 * ([ADR 0042](../../../../docs/adr/0042-agent-controlled-teaching-setup.md)).
 */
export const startTeaching = (params: Parameters<"agent_session_start">) =>
  Effect.gen(function* openAndHandOffTeaching() {
    const started = yield* call("agent_session_start", params);
    return yield* call("agent_teaching_setup_handoff", {
      sessionId: started.id,
    });
  });

type JourneyServices = Script | Scope.Scope | NodeServices.NodeServices;

/**
 * Registers a journey. It runs on the in-process adapter; a `singleTool`
 * journey also runs over HTTP and is tagged `@single-tool`. A `demo`
 * journey calls the demo store's operations, so it runs only over HTTP. With
 * `RECORD_TRANSCRIPTS=1`, its HTTP run rewrites its `transcript`.
 */
export const journey = <E>(
  name: string,
  options: {
    readonly demo?: boolean;
    readonly singleTool?: boolean;
    readonly timeout?: number;
    readonly transcript?: string;
  },
  body: Effect.Effect<void, E, JourneyServices>
) => {
  const overHttp = options.singleTool === true || options.demo === true;
  const adapters: readonly Adapter[] = [
    ...(options.demo === true ? [] : (["in-process"] as const)),
    ...(overHttp ? (["http"] as const) : []),
  ];
  const tag = overHttp ? " @single-tool" : "";
  for (const adapter of adapters) {
    it.live(
      `${name}${tag} (${adapter})`,
      () =>
        Effect.gen(function* runJourney() {
          const script = makeScript(adapter);
          yield* body.pipe(Effect.provideService(Script, script));
          if (
            RECORD_TRANSCRIPTS &&
            adapter === "http" &&
            options.transcript !== undefined
          ) {
            yield* writeTranscript(
              script.recorder.transcript(options.transcript)
            );
          }
        }).pipe(Effect.provide(NodeServices.layer)),
      options.timeout
    );
  }
};

/**
 * Replays a transcript over HTTP against fresh processes on `root`. Each
 * program must end as it did when it was recorded; each token takes this
 * replay's value from the step it was bound to, or from `environment`.
 */
export const replayTranscript = (
  transcript: Transcript,
  options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly root: string;
  }
) =>
  Effect.gen(function* replay() {
    const values = new Map<number, Schema.Json>();
    const processes: {
      readonly index: number;
      readonly step: Transcript["steps"][number];
    }[][] = [];
    for (const [index, step] of transcript.steps.entries()) {
      if (step._tag === "process") {
        processes.push([]);
        continue;
      }
      const current = processes.at(-1);
      if (current === undefined) {
        return yield* Effect.die("A transcript starts with a process.");
      }
      current.push({ index, step });
    }
    for (const steps of processes) {
      yield* Effect.gen(function* replayProcess() {
        const execute = yield* connectToMcp;
        for (const { index, step } of steps) {
          const tokens = yield* resolveTokens(transcript, {
            environment: options.environment,
            index,
            values,
          });
          if (step._tag === "user") {
            yield* performUserAction(
              Schema.decodeUnknownSync(Schema.fromJsonString(UserAction))(
                substitute(JSON.stringify(step.action), tokens)
              )
            );
          } else if (step._tag === "program") {
            const execution = yield* execute(substitute(step.code, tokens));
            expect(outcomeOf(execution), `step ${index}`).toEqual(step.outcome);
            values.set(index, answeredValues(execution));
          }
        }
      }).pipe(
        Effect.provide(
          mcpServer.pipe(Layer.provideMerge(agentProcessLayer(options.root)))
        ),
        Effect.scoped
      );
    }
  });
