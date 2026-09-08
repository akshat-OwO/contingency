import path from "node:path";

import { AgentFlowDiagnostic } from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentRunState,
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
import { RecordingLive } from "../../src/services/recorder.ts";
import { RunSession } from "../../src/services/run-session.ts";

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
        RecordingLive,
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
    ),
    Layer.provide(
      // Audit View's Run Session is a different workspace: an Agent Session
      // never reaches it, and a test that finds otherwise should fail loudly.
      Layer.succeed(RunSession, {
        answerVariable: () => Effect.die("Not under test"),
        artifactPath: () => Effect.die("Not under test"),
        changes: () => Stream.never,
        get: () => Effect.succeed(null),
        loadFlow: () => Effect.die("Not under test"),
        start: () => Effect.die("Not under test"),
      })
    )
  );
};
