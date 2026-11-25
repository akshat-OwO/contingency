import path from "node:path";

import {
  AgentActionResult,
  AgentActSequenceResult,
  AgentRunSummary,
  AgentSessionCompact,
  AgentSessionSnapshot,
  BrowserFailureReason,
  FlowDiagnostic,
  OperationId,
} from "@contingency/protocol";
import type {
  AgentRunState,
  AgentSessionGet,
  AgentSessionGetResult,
  AgentSessionId,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import type { Clock } from "effect";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { Tool, Toolkit } from "effect/ai";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import type { AgentBrowserFactory } from "../../src/services/agent-browser-contract.ts";
import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import type { AndroidWorkspaceService } from "../../src/services/android-workspace.ts";
import {
  CreateBrowserLive,
  makeCreateBrowserLayer,
} from "../../src/services/create-browser.ts";
import type { CreateBrowserOptions } from "../../src/services/create-browser.ts";
import { discoverFlows } from "../../src/services/flow-catalog-layout.ts";
import type { FlowCatalogService } from "../../src/services/flow-catalog.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import type { IosWorkspaceService } from "../../src/services/ios-workspace.ts";
import {
  AgentRunToolHandlersLive,
  AgentRunTools,
} from "../../src/services/mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import {
  AgentCatalogToolHandlersLive,
  AgentCatalogTools,
} from "../../src/services/mcp-catalog.ts";
import { DeviceWorkspaceToolHandlersLive } from "../../src/services/mcp-device-workspace.ts";
import {
  McpProcessDiagnostics,
  defaultProcessInfo,
} from "../../src/services/mcp-process-info.ts";
import {
  TeachingRecordingToolHandlersLive,
  TeachingRecordingTools,
} from "../../src/services/mcp-teaching-recording.ts";
import {
  RunVideoRenderer,
  RunVideoRendererLive,
} from "../../src/services/run-video-renderer.ts";
import type { TeachingRecordingStoreService } from "../../src/services/teaching-recording-store.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../../src/services/teaching-recording-store.ts";

/** A small viewport: these suites read the accessibility tree, not pixels. */
export const agentViewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/** The structured failure an MCP client actually reads. */
export interface ToolFailure {
  readonly code: string;
  readonly diagnostics?: readonly FlowDiagnostic[] | undefined;
  readonly failureReference?: string | undefined;
  /** Why a Scripted Agent program ended for the user instead of answering. */
  readonly intervention?:
    | { readonly reasons: readonly string[]; readonly sessionId: string }
    | undefined;
  readonly message: string;
  readonly reason?: typeof BrowserFailureReason.Type | undefined;
}

const ToolFailureSchema = Schema.Struct({
  code: Schema.String,
  diagnostics: Schema.optional(Schema.Array(FlowDiagnostic)),
  failureReference: Schema.optional(Schema.String),
  message: Schema.String,
  reason: Schema.optional(BrowserFailureReason),
});

export const decodeToolFailure = <Value>(
  value: Value
): ToolFailure | undefined =>
  Schema.decodeUnknownOption(ToolFailureSchema)(value).pipe(
    Option.getOrUndefined
  );

const isToolFailure = <Failure>(
  failure: Failure
): failure is Failure & ToolFailure => decodeToolFailure(failure) !== undefined;

/**
 * A handler's failure, kept as it was raised, when it carries what an MCP
 * client reads; an undeclared one is a defect.
 */
export const declaredFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((failure) =>
      isToolFailure(failure) ? failure : undefined
    ),
    Effect.catchIf(Predicate.isUndefined, () =>
      Effect.die("The tool failed with an undeclared failure.")
    )
  );

/**
 * These suites explicitly request full sessions when inspecting node/history
 * fields. Agent-format calls keep the product defaults. Unpublished fields
 * (ADR 0045) are decoded with their protocol schemas.
 */
export type Readable<T> = T extends { readonly session: infer S }
  ? unknown extends S
    ? Omit<T, "session"> & { readonly session: AgentSessionSnapshot }
    : T
  : T extends { readonly sessions: infer S }
    ? unknown extends S
      ? { readonly sessions: readonly AgentSessionSnapshot[] }
      : T
    : T extends { readonly summary: infer S; readonly viewUrl: string }
      ? unknown extends S
        ? Omit<T, "summary"> & { readonly summary: AgentRunSummary }
        : T
      : Exclude<T, AgentSessionCompact>;

/** What a test reads from one tool's success. */
export type CallSuccess<
  Tools extends Record<string, Tool.Any>,
  Name extends keyof Tools,
> = Name extends "agent_browser_resume"
  ? AgentActionResult
  : Name extends "agent_browser_act_sequence"
    ? AgentActSequenceResult
    : Readable<Tool.Success<Tools[Name]>>;

/** The fields each tool publishes as `unknown`, with the schema that reads them. */
const unknownFields = new Map<string, Schema.Decoder<object>>([
  [
    "agent_flow_dry_run_start",
    Schema.Struct({ session: AgentSessionSnapshot }),
  ],
  [
    "agent_sessions_get",
    Schema.Struct({ sessions: Schema.Array(AgentSessionSnapshot) }),
  ],
  ["open_run", Schema.Struct({ summary: AgentRunSummary })],
]);

/** The fields each tool leaves unpublished, with the schema that reads them. */
const unpublishedFields = new Map<string, Schema.Decoder<object>>([
  ["agent_browser_resume", AgentActionResult],
  ["agent_browser_act_sequence", AgentActSequenceResult],
  ...unknownFields,
]);

const isCompact = Schema.is(AgentSessionCompact);

const decodeFields = <Value>(
  fieldsByTool: ReadonlyMap<string, Schema.Decoder<object>>,
  name: string,
  value: Value
) =>
  Effect.gen(function* decodeUnpublished() {
    if (isCompact(value)) {
      return yield* Effect.die("A full session was expected, not compact.");
    }
    const fields = fieldsByTool.get(name);
    if (fields === undefined) {
      return value;
    }
    const decoded = yield* Schema.decodeUnknownEffect(fields)(value);
    return { ...value, ...decoded };
  });

const readable = <Value>(name: string, value: Value) =>
  decodeFields(unpublishedFields, name, value);

/**
 * What an agent reads from a full session view: the fields a tool publishes
 * as `unknown`, decoded with their protocol schemas.
 */
export const readPublished = <Value>(name: string, value: Value) =>
  decodeFields(unknownFields, name, value);

/** Tools that answer with a Browser Snapshot and take a `format`. */
const SNAPSHOT_TOOLS = new Set([
  "agent_browser_resume",
  "agent_browser_act",
  "agent_browser_act_sequence",
  "agent_browser_snapshot",
]);

/**
 * How a test call asks for its Snapshot. Most tests assert on node fields, so
 * they read the structured form unless they name a format. `agent` sends the
 * parameters untouched and gets the format an external agent gets by default.
 */
export type SnapshotFormatDefault = "structured" | "agent";

const withSnapshotFormat = <Params>(
  name: string,
  params: Params,
  snapshotFormat: SnapshotFormatDefault
): Params => {
  if (
    snapshotFormat !== "structured" ||
    !SNAPSHOT_TOOLS.has(name) ||
    !Predicate.isObjectKeyword(params) ||
    Predicate.hasProperty(params, "format")
  ) {
    return params;
  }
  return { ...params, format: "structured" };
};

/** Whether a tool's parameters declare a field. */
export const hasParameter = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  name: keyof Tools,
  field: string
) => {
  const parameters = toolkit.tools[name]?.parametersSchema;
  return (
    Predicate.isObjectKeyword(parameters) &&
    Predicate.hasProperty(parameters, "fields") &&
    Predicate.isObjectKeyword(parameters.fields) &&
    Predicate.hasProperty(parameters.fields, field)
  );
};

/**
 * The parameters a test call sends: a full session view and a structured
 * Snapshot unless the call names its own, so tests can assert on fields.
 */
export const callParameters = <Tools extends Record<string, Tool.Any>, Params>(
  toolkit: Toolkit.Toolkit<Tools>,
  name: keyof Tools,
  params: Params,
  snapshotFormat: SnapshotFormatDefault = "structured"
): Params => {
  const selected =
    snapshotFormat === "structured" &&
    Predicate.isObjectKeyword(params) &&
    !Predicate.hasProperty(params, "view") &&
    hasParameter(toolkit, name, "view")
      ? { ...params, view: "full" }
      : params;
  return withSnapshotFormat(String(name), selected, snapshotFormat);
};

/**
 * One tool's answer as a test reads it: a structured failure raised, or the
 * success decoded with the tool's schema and its unpublished fields.
 */
// SAFETY: the generator fails only with a decoded ToolFailure and succeeds
// with the decoded success `CallSuccess` names.
export const readToolResult = <
  Tools extends Record<string, Tool.Any>,
  Name extends keyof Tools,
  Result,
>(
  toolkit: Toolkit.Toolkit<Tools>,
  name: Name,
  result: Result
): Effect.Effect<
  CallSuccess<Tools, Name>,
  ToolFailure,
  Tool.ResultDecodingServices<Tools[Name]>
> =>
  Effect.gen(function* readResult() {
    const failure = decodeToolFailure(result);
    if (failure !== undefined) {
      return yield* Effect.fail(failure);
    }
    const tool = toolkit.tools[name];
    if (tool === undefined) {
      return yield* Effect.die(`The ${String(name)} tool is not registered.`);
    }
    const success = yield* Schema.decodeUnknownEffect(tool.successSchema)(
      result
    ).pipe(
      Effect.flatMap((decoded) => readable(String(name), decoded)),
      Effect.orDie
    );
    // SAFETY: the success schema decodes this tool's answer, and `readable`
    // adds exactly the fields `CallSuccess` names.
    return success as CallSuccess<Tools, Name>;
  }) as Effect.Effect<
    CallSuccess<Tools, Name>,
    ToolFailure,
    Tool.ResultDecodingServices<Tools[Name]>
  >;

/**
 * One MCP tool call, as the external agent makes it: validated parameters in,
 * the tool's success value out, and a structured failure raised so a test
 * asserts on it with `Effect.flip`.
 */
export const makeCall =
  <Tools extends Record<string, Tool.Any>>(
    toolkit: Toolkit.Toolkit<Tools>,
    snapshotFormat: SnapshotFormatDefault = "structured"
  ) =>
  <Name extends keyof Tools>(
    name: Name,
    params: Tool.Parameters<Tools[Name]>
  ): Effect.Effect<
    CallSuccess<Tools, Name>,
    ToolFailure,
    Tool.HandlersFor<Tools> | Tool.ResultDecodingServices<Tools[Name]>
  > =>
    Effect.gen(function* callTool() {
      const handlers = yield* toolkit;
      const results = yield* handlers
        .handle(name, callParameters(toolkit, name, params, snapshotFormat))
        .pipe(Effect.orDie, Effect.flatMap(Stream.runCollect), declaredFailure);
      const last = results.at(-1);
      if (last === undefined) {
        return yield* Effect.die(`The ${String(name)} tool answered nothing.`);
      }
      return yield* readToolResult(toolkit, name, last.result);
    });

/** The agent's session, catalog, and Run tools, called the way MCP calls them. */
export const sessionTool = makeCall(AgentSessionTools);
export const catalogTool = makeCall(AgentCatalogTools);
export const runTool = makeCall(AgentRunTools);
export const teachingRecordingTool = makeCall(TeachingRecordingTools);

/** Wait on Session Events until the snapshot satisfies the next assertion. */
export const awaitSession = <E, R>(
  client: (
    name: "agent.session.get",
    params: AgentSessionGet
  ) => Effect.Effect<AgentSessionGetResult, E, R>,
  sessionId: AgentSessionId,
  until: (session: AgentSessionSnapshot) => boolean
) =>
  Effect.gen(function* awaitSessionState() {
    let { session } = yield* client("agent.session.get", { sessionId });
    while (!until(session)) {
      const afterCursor = session.eventCursor;
      if (afterCursor === undefined) {
        return yield* Effect.die("The Agent Session returned no event cursor.");
      }
      ({ session } = yield* client("agent.session.get", {
        afterCursor,
        sessionId,
      }));
    }
    return session;
  }).pipe(Effect.timeout("30 seconds"));

/**
 * Open Teaching the way an agent does, then hand the browser straight to the
 * user who demonstrates the journey. An agent-opened Teaching session starts
 * with the agent preparing setup, so Start waits for this handoff
 * ([ADR 0042](../../../../docs/adr/0042-agent-controlled-teaching-setup.md)).
 */
export const startUserTeaching = (
  params: Parameters<typeof sessionTool<"agent_session_start">>[1]
) =>
  Effect.gen(function* openAndHandOffTeaching() {
    const started = yield* sessionTool("agent_session_start", params);
    return yield* sessionTool("agent_teaching_setup_handoff", {
      operationId: OperationId.make(`${params.operationId}-handoff`),
      sessionId: started.id,
    });
  });

/** One node of a Browser Snapshot, or a failure naming what was actually there. */
export const findNode = <Node extends Pick<AgentSnapshotNode, "name" | "role">>(
  nodes: readonly Node[],
  role: string,
  name: string
): Node => {
  const found = nodes.find(
    (node) => node.role === role && node.name.includes(name)
  );
  if (found === undefined) {
    throw new Error(
      `The Browser Snapshot had no ${role} named ${name}: ${nodes
        .map((node) => `${node.role}/${node.name}`)
        .join(", ")}`
    );
  }
  return found;
};

/** The Interactive Run a snapshot is performing. */
export const requireRun = (snapshot: AgentSessionSnapshot): AgentRunState => {
  const state = snapshot.run;
  if (state === null || "schemaVersion" in state) {
    throw new Error("The Agent Session was not performing an Interactive Run.");
  }
  return state;
};

/** The Execution Boundary an action was refused at. */
export const requireBoundary = (result: AgentActionResult) => {
  if (result.intervention === undefined) {
    throw new Error("Expected an Execution Boundary");
  }
  return result.intervention;
};

/** The open boundary decision the session is waiting on, as the agent reads it. */
export const requireBoundaryDecision = (
  snapshot: AgentSessionSnapshot,
  boundaryId: string
) => {
  const decision = snapshot.pendingDecisions.find(
    (pending) =>
      pending.kind === "boundary" && pending.boundaryId === boundaryId
  );
  if (decision === undefined) {
    throw new Error(
      `The Agent Session had no pending decision for boundary ${boundaryId}.`
    );
  }
  return decision;
};

/**
 * Relay the user's choice about one paused Execution Boundary the way the
 * external agent does: read the session's pending decisions, then resolve the
 * server-issued id ([ADR 0037](../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)).
 */
export const resolveBoundary = (input: {
  readonly boundaryId: string;
  readonly decision: "allow" | "refuse";
  readonly operationId: string;
  readonly sessionId: AgentSessionId;
}) =>
  Effect.gen(function* relayBoundaryDecision() {
    const snapshot = yield* sessionTool("agent_session_get", {
      sessionId: input.sessionId,
    });
    return yield* catalogTool("agent_pending_decision_resolve", {
      decision: input.decision,
      operationId: OperationId.make(input.operationId),
      pendingDecisionId: requireBoundaryDecision(snapshot, input.boundaryId)
        .pendingDecisionId,
    });
  });

/** The open decision for one runtime Variable, as the agent reads it. */
export const requireVariableDecision = (
  snapshot: AgentSessionSnapshot,
  name: string
) => {
  const decision = snapshot.pendingDecisions.find(
    (pending) =>
      pending.kind === "supply_variable" && pending.variable?.name === name
  );
  if (decision === undefined) {
    throw new Error(
      `The Agent Session had no pending decision for Variable ${name}.`
    );
  }
  return decision;
};

/**
 * Relay the user's answer about one runtime Variable the way the external
 * agent does: read the session's pending decisions, then resolve the
 * server-issued id with the literal the user typed in the conversation
 * ([ADR 0037](../../../../docs/adr/0037-pending-decisions-relay-user-consent-over-mcp.md)).
 */
export const resolveVariable = (input: {
  readonly decision: "supply" | "refuse";
  readonly name: string;
  readonly operationId: string;
  readonly sessionId: AgentSessionId;
  readonly value?: string;
}) =>
  Effect.gen(function* relayVariableDecision() {
    const snapshot = yield* sessionTool("agent_session_get", {
      sessionId: input.sessionId,
    });
    return yield* catalogTool("agent_pending_decision_resolve", {
      decision: input.decision,
      operationId: OperationId.make(input.operationId),
      pendingDecisionId: requireVariableDecision(snapshot, input.name)
        .pendingDecisionId,
      value: input.value,
    });
  });

/** Services an optional native Workspace layer may draw from the process. */
export type NativeWorkspaceDependencies =
  | FlowCatalogService
  | TeachingRecordingStoreService
  | FileSystem.FileSystem;

export type AndroidWorkspaceLayer = Layer.Layer<
  AndroidWorkspaceService,
  never,
  NativeWorkspaceDependencies
>;

export type IosWorkspaceLayer = Layer.Layer<
  IosWorkspaceService,
  never,
  NativeWorkspaceDependencies
>;

/**
 * One MCP process's whole public surface over one Catalog Root: the agent's
 * toolkits and the Workspace's loopback RPC, over a real Chromium and any
 * supplied native Workspaces.
 *
 * Each call builds a fresh registry, which is how a test spends more than one
 * process lifetime: nothing but the persisted Flow, Teaching Recording,
 * and Run packages crosses between them.
 */
export const agentProcessLayer = <
  A extends AndroidWorkspaceService = never,
  I extends IosWorkspaceService = never,
>(
  initialCatalogRoot: string,
  options: {
    readonly agentBrowserFactory?: AgentBrowserFactory;
    readonly androidWorkspace?:
      | Layer.Layer<A, never, NativeWorkspaceDependencies>
      | undefined;
    readonly followCatalogSelection?: boolean;
    readonly iosWorkspace?:
      | Layer.Layer<I, never, NativeWorkspaceDependencies>
      | undefined;
    /** Paces scroll pauses, for tests that close a gesture on demand. */
    readonly scrollClock?: Clock.Clock;
    /** The Agent Session registry's clock, for tests that move time. */
    readonly now?: () => Date;
    /** This process's owner marker, under which per-session resources live. */
    readonly resourceDirectory?: string;
    /** Browser launch seams, such as the site corpus replay proxy. */
    readonly createBrowser?: CreateBrowserOptions;
  } = {}
) => {
  let selectedCatalogRoot = initialCatalogRoot;
  const {
    androidWorkspace,
    createBrowser,
    followCatalogSelection,
    iosWorkspace,
    now,
    ...sessionSeams
  } = options;
  const sessionOptions = {
    ...sessionSeams,
    allowedActivity: "any" as const,
    baseUrl: "http://127.0.0.1:7777",
    catalogRoot: () => selectedCatalogRoot,
    now: now ?? (() => new Date()),
    traceDirectory: () =>
      path.join(selectedCatalogRoot, TEACHING_RECORDINGS_DIRECTORY),
  };
  const catalogOptions = { root: initialCatalogRoot };
  const recordingStore = makeTeachingRecordingStoreLayer({
    root: () => selectedCatalogRoot,
  });
  // A Run persists its own Summary as it ends, so the registry reads the same
  // store the Run tools do.
  const runStore = makeAgentRunStoreLayer({ root: () => selectedCatalogRoot });
  const baseServices = Layer.mergeAll(
    makeAgentSessionLayer(sessionOptions).pipe(
      Layer.provide(
        Layer.mergeAll(runStore, recordingStore, RunVideoRendererLive)
      )
    ),
    makeFlowCatalogLayer(
      followCatalogSelection === true
        ? {
            ...catalogOptions,
            onSelect: (root: string) => {
              selectedCatalogRoot = root;
            },
          }
        : catalogOptions
    ),
    Layer.succeed(McpProcessDiagnostics, {
      read: defaultProcessInfo(),
    }),
    runStore,
    recordingStore,
    RunVideoRendererLive
  ).pipe(
    Layer.provideMerge(
      createBrowser === undefined
        ? CreateBrowserLive
        : makeCreateBrowserLayer(createBrowser)
    ),
    Layer.provideMerge(NodeServices.layer)
  );
  // SAFETY: when a native workspace layer is omitted, its type parameter
  // defaults to `never`, matching `Layer.empty`.
  const optionalAndroid = (androidWorkspace ?? Layer.empty) as Layer.Layer<
    A,
    never,
    NativeWorkspaceDependencies
  >;
  // SAFETY: when a native workspace layer is omitted, its type parameter
  // defaults to `never`, matching `Layer.empty`.
  const optionalIos = (iosWorkspace ?? Layer.empty) as Layer.Layer<
    I,
    never,
    NativeWorkspaceDependencies
  >;
  const services = Layer.mergeAll(optionalAndroid, optionalIos).pipe(
    Layer.provideMerge(baseServices)
  );
  return Layer.mergeAll(
    RpcHandlersLive,
    AgentSessionToolHandlersLive,
    AgentCatalogToolHandlersLive,
    AgentRunToolHandlersLive,
    TeachingRecordingToolHandlersLive,
    DeviceWorkspaceToolHandlersLive
  ).pipe(Layer.provideMerge(services));
};

/**
 * Wait for a finished Run's video to be condensed. It is encoded after the
 * Run Summary is written, so a test that reads the file waits for it.
 */
export const awaitRunVideo = (directory: string) =>
  Effect.gen(function* settledRunVideo() {
    const renderer = yield* RunVideoRenderer;
    yield* renderer.settled(directory).pipe(Effect.timeout("120 seconds"));
    return yield* renderer.status(directory);
  });

/** Locate persisted evidence after a Flow move, without creating directories. */
export const evidenceDirectory = (
  root: string,
  kind: "recordings" | "runs",
  id: string | null
) =>
  Effect.gen(function* locateEvidence() {
    if (id === null) {
      return yield* Effect.die("Expected an evidence identity");
    }
    const fs = yield* FileSystem.FileSystem;
    const flows = yield* discoverFlows(root, fs);
    for (const flow of flows.values()) {
      const directory = path.join(flow.directory, kind, id);
      if (yield* fs.exists(directory)) {
        return directory;
      }
    }
    return path.join(root, kind, id);
  });
