import path from "node:path";

import {
  AgentRunSummary,
  AgentSessionCompact,
  AgentSessionSnapshot,
  FlowSkillDiagnostic,
  OperationId,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentRunState,
  AgentSessionId,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Predicate, Schema, Stream } from "effect";
import type { Tool, Toolkit } from "effect/ai";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
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
import {
  TeachingRecordingToolHandlersLive,
  TeachingRecordingTools,
} from "../../src/services/mcp-teaching-recording.ts";
import {
  RunVideoRenderer,
  RunVideoRendererLive,
} from "../../src/services/run-video-renderer.ts";
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
  readonly diagnostics?: readonly FlowSkillDiagnostic[] | undefined;
  readonly message: string;
}

const decodeToolSuccess = <Success extends Schema.Top>(
  schema: Success,
  result: typeof schema.Encoded
) => Schema.decodeUnknownEffect(schema)(result);

const ToolFailureSchema = Schema.Struct({
  code: Schema.String,
  diagnostics: Schema.optional(Schema.Array(FlowSkillDiagnostic)),
  message: Schema.String,
});

const decodeToolFailure = <Value>(value: Value): ToolFailure | undefined =>
  Schema.decodeUnknownOption(ToolFailureSchema)(value).pipe(
    Option.getOrUndefined
  );

/**
 * A tool's success as these suites read it. Tests that never ask for
 * `view:"compact"` read full sessions, and the fields the catalog leaves
 * unpublished (ADR 0045) are decoded with their protocol schemas.
 */
type Readable<T> = T extends { readonly session: infer S }
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

/** The fields each tool leaves unpublished, with the schema that reads them. */
const unpublishedFields = new Map<string, Schema.Decoder<object>>([
  [
    "agent_flow_skill_dry_run_start",
    Schema.Struct({ session: AgentSessionSnapshot }),
  ],
  [
    "agent_sessions_get",
    Schema.Struct({ sessions: Schema.Array(AgentSessionSnapshot) }),
  ],
  ["open_run", Schema.Struct({ summary: AgentRunSummary })],
]);

const isCompact = Schema.is(AgentSessionCompact);

const readable = <Value>(name: string, value: Value) =>
  Effect.gen(function* decodeUnpublished() {
    if (isCompact(value)) {
      return yield* Effect.die("A full session was expected, not compact.");
    }
    const fields = unpublishedFields.get(name);
    if (fields === undefined) {
      return value;
    }
    const decoded = yield* Schema.decodeUnknownEffect(fields)(value);
    return { ...value, ...decoded };
  });

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

/**
 * One MCP tool call, as the external agent makes it: validated parameters in,
 * the tool's success value out, and a structured failure raised so a test
 * asserts on it with `Effect.flip`.
 */
export function makeCall<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  snapshotFormat?: SnapshotFormatDefault
): <Name extends keyof Tools>(
  name: Name,
  params: Tool.Parameters<Tools[Name]>
) => Effect.Effect<
  Readable<Tool.Success<Tools[Name]>>,
  ToolFailure,
  Tool.HandlersFor<Tools> | Tool.ResultDecodingServices<Tools[Name]>
>;
export function makeCall<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  snapshotFormat: SnapshotFormatDefault = "structured"
) {
  return <Name extends keyof Tools>(
    name: Name,
    params: Tool.Parameters<Tools[Name]>
  ) =>
    Effect.gen(function* callTool() {
      const handlers = yield* toolkit;
      const results = yield* handlers
        .handle(name, withSnapshotFormat(String(name), params, snapshotFormat))
        .pipe(Effect.orDie, Effect.flatMap(Stream.runCollect));
      const last = results.at(-1);
      if (last === undefined) {
        return yield* Effect.die(`The ${String(name)} tool answered nothing.`);
      }
      const { result } = last;
      const failure = decodeToolFailure(result);
      if (failure !== undefined) {
        return yield* Effect.fail(failure);
      }
      const tool = toolkit.tools[name];
      if (tool === undefined) {
        return yield* Effect.die(`The ${String(name)} tool is not registered.`);
      }
      return yield* decodeToolSuccess(tool.successSchema, result).pipe(
        Effect.flatMap((success) => readable(String(name), success)),
        Effect.orDie
      );
    });
}

/** The agent's session, catalog, and Run tools, called the way MCP calls them. */
export const sessionTool = makeCall(AgentSessionTools);
export const catalogTool = makeCall(AgentCatalogTools);
export const runTool = makeCall(AgentRunTools);
export const teachingRecordingTool = makeCall(TeachingRecordingTools);

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
export const findNode = (
  nodes: readonly AgentSnapshotNode[],
  role: string,
  name: string
): AgentSnapshotNode => {
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

/**
 * One MCP process's whole public surface over one Catalog Root: the agent's
 * toolkits and the Workspace's loopback RPC, over a real Chromium.
 *
 * Each call builds a fresh registry, which is how a test spends more than one
 * process lifetime: nothing but the persisted Flow Skill, Teaching Recording,
 * and Run packages crosses between them.
 */
export const agentProcessLayer = (
  initialCatalogRoot: string,
  options: {
    readonly followCatalogSelection?: boolean;
    /** The Agent Session registry's clock, for tests that move time. */
    readonly now?: () => Date;
    /** This process's owner marker, under which per-session resources live. */
    readonly resourceDirectory?: string;
  } = {}
) => {
  let selectedCatalogRoot = initialCatalogRoot;
  const sessionOptions = {
    allowedActivity: "any" as const,
    baseUrl: "http://127.0.0.1:7777",
    now: options.now ?? (() => new Date()),
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
  return Layer.mergeAll(
    RpcHandlersLive,
    AgentSessionToolHandlersLive,
    AgentCatalogToolHandlersLive,
    AgentRunToolHandlersLive,
    TeachingRecordingToolHandlersLive
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        makeAgentSessionLayer(
          options.resourceDirectory === undefined
            ? sessionOptions
            : {
                ...sessionOptions,
                resourceDirectory: options.resourceDirectory,
              }
        ).pipe(
          Layer.provide(
            Layer.mergeAll(runStore, recordingStore, RunVideoRendererLive)
          )
        ),
        makeFlowSkillCatalogLayer(
          options.followCatalogSelection === true
            ? {
                ...catalogOptions,
                onSelect: (root: string) => {
                  selectedCatalogRoot = root;
                },
              }
            : catalogOptions
        ),
        runStore,
        recordingStore,
        RunVideoRendererLive
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );
};

/**
 * Wait for a finished Run's video to be condensed. It is encoded after the
 * Run Summary is written, so a test that reads the file waits for it.
 */
export const awaitRunVideo = (directory: string) =>
  Effect.gen(function* pollRunVideo() {
    const renderer = yield* RunVideoRenderer;
    let status = yield* renderer.status(directory);
    while (status.state === "preparing") {
      yield* Effect.sleep("100 millis");
      status = yield* renderer.status(directory);
    }
    return status;
  }).pipe(Effect.timeout("120 seconds"));
