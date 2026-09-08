import path from "node:path";

import {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentRunId,
  AgentSessionId,
} from "@contingency/protocol";
import type { AgentRunSummary } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  AGENT_RUNS_DIRECTORY,
  AgentRunStore,
  DEFAULT_AGENT_RUN_CEILING_MS,
  DEFAULT_AGENT_STEP_CEILING_MS,
  makeAgentRunStoreLayer,
} from "../../src/services/agent-run-store.ts";

const runId = AgentRunId.make("agentrun-store-test");

const summaryFor = (root: string): AgentRunSummary =>
  ({
    agentFlowId: AgentFlowId.make("flow-catalogue"),
    assessmentCounts: {
      blocked: 0,
      inconclusive: 0,
      notWorking: 1,
      working: 1,
    },
    attribution: {
      clientName: "integration-agent",
      clientVersion: "1.0.0",
      reportedMetadataVerified: false,
      reportedModel: null,
      reportedProvider: null,
    },
    ceilings: { extensions: 1, runMs: 900_000, stepMs: 120_000 },
    coverage: { complete: false, executed: 2, total: 3, unexecuted: 1 },
    endedAt: "2026-09-04T00:02:00.000Z",
    outcome: "ended-early",
    revisionId: AgentFlowRevisionId.make("rev-one"),
    runId,
    schemaVersion: 1,
    sessionId: AgentSessionId.make("agent-one"),
    startedAt: "2026-09-04T00:00:00.000Z",
    steps: [
      {
        assessment: {
          attempts: 1,
          evidence: [{ id: "snapshot-1", kind: "snapshot" }],
          explanation: "The catalogue listed the expected products.",
          outcome: "working",
          submittedAt: "2026-09-04T00:00:30.000Z",
        },
        attempts: 1,
        confirmation: false,
        description: "Open the catalogue.",
        endedAt: "2026-09-04T00:00:30.000Z",
        execution: "assessed",
        index: 0,
        name: "Open",
        startedAt: "2026-09-04T00:00:01.000Z",
      },
      {
        assessment: {
          attempts: 3,
          evidence: [{ id: "attempt-1", kind: "attempt" }],
          explanation: "The basket never showed the product.",
          outcome: "not-working",
          submittedAt: "2026-09-04T00:01:30.000Z",
        },
        attempts: 3,
        confirmation: false,
        description: "Add the product to the basket.",
        endedAt: "2026-09-04T00:01:30.000Z",
        execution: "assessed",
        index: 1,
        name: "Add to basket",
        startedAt: "2026-09-04T00:00:31.000Z",
      },
      {
        assessment: null,
        attempts: 0,
        confirmation: true,
        description: "Complete the purchase.",
        endedAt: null,
        execution: "unexecuted",
        index: 2,
        name: "Check out",
        startedAt: null,
      },
    ],
    summary: "The basket never accepted the product.",
    timeline: [],
    title: "Buy one product",
    tracePath: null,
    videoPath: `${path.basename(root)}-nowhere.webm`,
  }) satisfies AgentRunSummary;

const layerFor = (root: string) =>
  makeAgentRunStoreLayer({ root: () => root }).pipe(
    Layer.provideMerge(NodeServices.layer)
  );

it.effect("persists a Run Summary that another process can read back", () =>
  Effect.gen(function* readBackARunSummary() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-store-",
    });
    const summary = summaryFor(root);
    yield* Effect.gen(function* write() {
      const store = yield* AgentRunStore;
      yield* store.write(summary);
    }).pipe(Effect.provide(layerFor(root)));
    // A second store over the same Catalog Root is a stand-in for a later MCP
    // process: nothing but the persisted package travels between them.
    const read = yield* Effect.gen(function* readAgain() {
      const store = yield* AgentRunStore;
      return yield* store.read(summary.runId);
    }).pipe(Effect.provide(layerFor(root)));
    expect(read).toEqual(summary);
    expect(
      yield* fileSystem.exists(
        path.join(root, AGENT_RUNS_DIRECTORY, summary.runId, "summary.json")
      )
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("reports a missing Run rather than inventing an empty one", () =>
  Effect.gen(function* readAbsentRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-store-",
    });
    const failure = yield* Effect.gen(function* read() {
      const store = yield* AgentRunStore;
      return yield* Effect.flip(store.read(AgentRunId.make("agentrun-absent")));
    }).pipe(Effect.provide(layerFor(root)));
    expect(failure.code).toBe("agent_run_not_found");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "takes ceilings from the Catalog Root policy when it declares them",
  () =>
    Effect.gen(function* readCeilingPolicy() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-store-",
      });
      const readCeilings = Effect.gen(function* ceilings() {
        const store = yield* AgentRunStore;
        return yield* store.ceilings();
      }).pipe(Effect.provide(layerFor(root)));

      expect(yield* readCeilings).toEqual({
        runMs: DEFAULT_AGENT_RUN_CEILING_MS,
        stepMs: DEFAULT_AGENT_STEP_CEILING_MS,
      });

      yield* fileSystem.writeFileString(
        path.join(root, "agent-flow-catalog.json"),
        JSON.stringify({
          agentRunCeilings: { runCeilingMs: 60_000, stepCeilingMs: 5000 },
        })
      );
      expect(yield* readCeilings).toEqual({ runMs: 60_000, stepMs: 5000 });

      // An unreadable policy must not stop a Run from starting.
      yield* fileSystem.writeFileString(
        path.join(root, "agent-flow-catalog.json"),
        "{ not json"
      );
      expect(yield* readCeilings).toEqual({
        runMs: DEFAULT_AGENT_RUN_CEILING_MS,
        stepMs: DEFAULT_AGENT_STEP_CEILING_MS,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
