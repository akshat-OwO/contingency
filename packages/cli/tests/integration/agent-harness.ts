import path from "node:path";

import { AgentFlowDiagnostic, OperationId } from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentFlowRevision,
  AgentRunState,
  AgentSessionId,
  AgentSessionSnapshot,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentFlowCatalogLayer } from "../../src/services/agent-flow-catalog.ts";
import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentFlowToolHandlersLive,
  AgentFlowTools,
} from "../../src/services/mcp-agent-flow.ts";
import {
  AgentRunToolHandlersLive,
  AgentRunTools,
} from "../../src/services/mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";

/** A small viewport: these suites read the accessibility tree, not pixels. */
export const agentViewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/** The structured failure an MCP client actually reads. */
export interface ToolFailure {
  readonly code: string;
  readonly diagnostics?: readonly AgentFlowDiagnostic[] | undefined;
  readonly message: string;
}

const decodeToolSuccess = <Success extends Schema.Top>(
  schema: Success,
  result: typeof schema.Encoded
) => Schema.decodeUnknownEffect(schema)(result);

const ToolFailureSchema = Schema.Struct({
  code: Schema.String,
  diagnostics: Schema.optional(Schema.Array(AgentFlowDiagnostic)),
  message: Schema.String,
});

const decodeToolFailure = <Value>(value: Value): ToolFailure | undefined =>
  Schema.decodeUnknownOption(ToolFailureSchema)(value).pipe(
    Option.getOrUndefined
  );

/**
 * One MCP tool call, as the external agent makes it: validated parameters in,
 * the tool's success value out, and a structured failure raised so a test
 * asserts on it with `Effect.flip`.
 */
export function makeCall<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): <Name extends keyof Tools>(
  name: Name,
  params: Tool.Parameters<Tools[Name]>
) => Effect.Effect<
  Tool.Success<Tools[Name]>,
  ToolFailure,
  Tool.HandlersFor<Tools> | Tool.ResultDecodingServices<Tools[Name]>
>;
export function makeCall<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) {
  return <Name extends keyof Tools>(
    name: Name,
    params: Tool.Parameters<Tools[Name]>
  ) =>
    Effect.gen(function* callTool() {
      const handlers = yield* toolkit;
      const results = yield* handlers
        .handle(name, params)
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
        Effect.orDie
      );
    });
}

/** The agent's session, catalog, and Run tools, called the way MCP calls them. */
export const sessionTool = makeCall(AgentSessionTools);
export const flowTool = makeCall(AgentFlowTools);
export const runTool = makeCall(AgentRunTools);

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
  if (state === null) {
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

/**
 * The Agent Flow revision a resolved pending decision answered with. Resolving
 * a boundary decision answers with the Agent Session instead, so the revision
 * is asserted rather than assumed.
 */
export const requireRevision = (
  resolved: AgentFlowRevision | AgentSessionSnapshot
): AgentFlowRevision => {
  if (!("heads" in resolved)) {
    throw new Error("The resolved decision was not an Agent Flow decision.");
  }
  return resolved;
};

/** The Agent Session a resolved boundary decision answered with. */
export const requireSessionSnapshot = (
  resolved: AgentFlowRevision | AgentSessionSnapshot
): AgentSessionSnapshot => {
  if ("heads" in resolved) {
    throw new Error("The resolved decision was not a boundary decision.");
  }
  return resolved;
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
    return requireSessionSnapshot(
      yield* flowTool("agent_pending_decision_resolve", {
        decision: input.decision,
        operationId: OperationId.make(input.operationId),
        pendingDecisionId: requireBoundaryDecision(snapshot, input.boundaryId)
          .pendingDecisionId,
      })
    );
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
    return requireSessionSnapshot(
      yield* flowTool("agent_pending_decision_resolve", {
        decision: input.decision,
        operationId: OperationId.make(input.operationId),
        pendingDecisionId: requireVariableDecision(snapshot, input.name)
          .pendingDecisionId,
        value: input.value,
      })
    );
  });

/**
 * One MCP process's whole public surface over one Catalog Root: the agent's
 * three toolkits and Agent View's loopback RPC, over a real Chromium.
 *
 * Each call builds a fresh registry, which is how a test spends more than one
 * process lifetime: nothing but the persisted catalog and Run packages crosses
 * between them.
 */
export const agentProcessLayer = (
  initialCatalogRoot: string,
  options: {
    readonly followCatalogSelection?: boolean;
    /** This process's owner marker, under which per-session resources live. */
    readonly resourceDirectory?: string;
  } = {}
) => {
  let selectedCatalogRoot = initialCatalogRoot;
  const sessionOptions = {
    baseUrl: "http://127.0.0.1:7777",
    traceDirectory: () => path.join(selectedCatalogRoot, "teaching"),
  };
  const catalogOptions = { root: initialCatalogRoot };
  return Layer.mergeAll(
    RpcHandlersLive,
    AgentSessionToolHandlersLive,
    AgentFlowToolHandlersLive,
    AgentRunToolHandlersLive
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
        ),
        makeAgentFlowCatalogLayer(
          options.followCatalogSelection === true
            ? {
                ...catalogOptions,
                onSelect: (root: string) => {
                  selectedCatalogRoot = root;
                },
              }
            : catalogOptions
        ),
        makeAgentRunStoreLayer({ root: () => selectedCatalogRoot })
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );
};
