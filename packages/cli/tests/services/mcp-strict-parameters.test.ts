import { AgentSessionId, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  AgentFlowCatalog,
  makeAgentFlowCatalogLayer,
} from "../../src/services/agent-flow-catalog.ts";
import { AgentRunStore } from "../../src/services/agent-run-store.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
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
import { withStrictParameters } from "../../src/services/mcp-strict-parameters.ts";

const at = "2026-09-01T00:00:00.000Z";

/**
 * No handler may run when parameters are refused, so every dependency dies if
 * it is touched.
 */
const untouchedServices = Layer.mergeAll(
  Layer.mock(AgentSession, {}),
  Layer.mock(AgentRunStore, {})
);

const draftCarryingEvidence = {
  description: "A replayable public journey.",
  domainScope: { hosts: ["shop.example.com"] },
  schemaVersion: 1,
  steps: [
    {
      confirmation: false,
      description: "Open the shop.",
      evidence: {
        hash: "sha256-deadbeef",
        path: "evidence/sha256-deadbeef.json",
      },
      firstActionId: "action-open",
      lastActionId: "action-open",
      name: "Step supplying its own evidence",
    },
  ],
  title: "Replayable shop journey",
};

it.effect(
  "refuses a step proposal that carries agent-authored evidence, saving nothing",
  () =>
    Effect.gen(function* refuseAgentAuthoredEvidence() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-strict-evidence-",
      });
      const layer = AgentFlowToolHandlersLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            makeAgentFlowCatalogLayer({ now: () => new Date(at), root }),
            untouchedServices
          ).pipe(Layer.provide(NodeServices.layer))
        )
      );
      yield* Effect.gen(function* exerciseRefusal() {
        const handlers = yield* AgentFlowTools;
        // SAFETY: the draft carries the forged `evidence` key this test sends;
        // the rest of the payload is the shape the tool declares.
        const refused = yield* Effect.flip(
          handlers.handle("agent_flow_draft_save", {
            basedOnRevisionId: null,
            draft: draftCarryingEvidence,
            operationId: OperationId.make("strict-evidence"),
            sessionId: AgentSessionId.make("agent-teaching"),
          } as never)
        );
        expect(refused.reason._tag).toBe("ToolParameterValidationError");
        expect(refused.message).toContain("evidence");
        expect(refused.message).toContain("steps");

        // Nothing was compiled, so the catalog stayed empty.
        const catalog = yield* AgentFlowCatalog;
        const found = yield* catalog.search({});
        expect(found.hits).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const catalogOnly = Layer.mock(AgentFlowCatalog, {});

it.effect("refuses an excess property on an agent flow tool", () =>
  Effect.gen(function* refuseExcessOnFlowTool() {
    const built = yield* AgentFlowTools;
    // SAFETY: the excess key is exactly what this test sends; the parameters
    // are otherwise the ones the tool declares.
    const refused = yield* Effect.flip(
      built.handle("agent_flow_get", {
        agentFlowId: "flow-1",
        revisionId: null,
        unexpected: true,
      } as never)
    );
    expect(refused.message).toContain("unexpected");
  }).pipe(
    Effect.provide(
      AgentFlowToolHandlersLive.pipe(
        Layer.provide(Layer.mergeAll(catalogOnly, untouchedServices))
      )
    )
  )
);

it.effect("refuses an excess property on an agent run tool", () =>
  Effect.gen(function* refuseExcessOnRunTool() {
    const built = yield* AgentRunTools;
    // SAFETY: as above, only the excess key departs from the declared shape.
    const refused = yield* Effect.flip(
      built.handle("open_run", { runId: "run-1", unexpected: true } as never)
    );
    expect(refused.message).toContain("unexpected");
  }).pipe(
    Effect.provide(
      AgentRunToolHandlersLive.pipe(
        Layer.provide(Layer.mergeAll(catalogOnly, untouchedServices))
      )
    )
  )
);

it.effect("refuses an excess property on an agent session tool", () =>
  Effect.gen(function* refuseExcessOnSessionTool() {
    const built = yield* AgentSessionTools;
    // SAFETY: as above, only the excess key departs from the declared shape.
    const refused = yield* Effect.flip(
      built.handle("agent_session_get", {
        sessionId: "agent-1",
        unexpected: true,
      } as never)
    );
    expect(refused.message).toContain("unexpected");
  }).pipe(
    Effect.provide(
      AgentSessionToolHandlersLive.pipe(Layer.provide(untouchedServices))
    )
  )
);

it("leaves every published JSON Schema unchanged", () => {
  const tool = Tool.make("sample", {
    description: "A tool whose published schema must survive wrapping.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
  });
  const published = Tool.getJsonSchema(tool);
  const wrapped = withStrictParameters(Toolkit.make(tool));
  expect(Tool.getJsonSchema(wrapped.tools.sample)).toEqual(published);

  for (const toolkit of [AgentFlowTools, AgentRunTools, AgentSessionTools]) {
    for (const shipped of Object.values(toolkit.tools)) {
      expect(Tool.getJsonSchema(shipped)).toEqual(
        Tool.getJsonSchemaFromSchema(shipped.parametersSchema)
      );
    }
  }
});
