import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import { AgentRunStore } from "../../src/services/agent-run-store.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import { FlowSkillCatalog } from "../../src/services/flow-skill-catalog.ts";
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
import { withStrictParameters } from "../../src/services/mcp-strict-parameters.ts";
import { TeachingRecordingTools } from "../../src/services/mcp-teaching-recording.ts";

/**
 * No handler may run when parameters are refused, so every dependency dies if
 * it is touched.
 */
const untouchedServices = Layer.mergeAll(
  Layer.mock(AgentSession, {}),
  Layer.mock(AgentRunStore, {}),
  Layer.mock(FlowSkillCatalog, {
    root: () => {
      throw new Error("A refused tool call must not read the Catalog Root.");
    },
  })
);

it.effect("refuses an excess property on a catalog tool", () =>
  Effect.gen(function* refuseExcessOnCatalogTool() {
    const built = yield* AgentCatalogTools;
    // SAFETY: the excess key is exactly what this test sends; the parameters
    // are otherwise the ones the tool declares.
    const refused = yield* Effect.flip(
      built.handle("agent_catalog_select", {
        operationId: "op-1",
        root: "/tmp/catalog",
        unexpected: true,
      } as never)
    );
    expect(refused.message).toContain("unexpected");
  }).pipe(
    Effect.provide(
      AgentCatalogToolHandlersLive.pipe(Layer.provide(untouchedServices))
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
      AgentRunToolHandlersLive.pipe(Layer.provide(untouchedServices))
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

  for (const toolkit of [
    AgentCatalogTools,
    AgentRunTools,
    AgentSessionTools,
    TeachingRecordingTools,
  ]) {
    for (const shipped of Object.values(toolkit.tools)) {
      expect(Tool.getJsonSchema(shipped)).toEqual(
        Tool.getJsonSchemaFromSchema(shipped.parametersSchema)
      );
    }
  }
});
