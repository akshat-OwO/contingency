import path from "node:path";

import {
  AgentRunId,
  AgentSessionId,
  FlowSkillName,
} from "@contingency/protocol";
import type { LegacyAgentRunSummary as AgentRunSummary } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  AGENT_RUNS_DIRECTORY,
  AgentRunStore,
  makeAgentRunStoreLayer,
} from "../../src/services/agent-run-store.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const runId = AgentRunId.make("agentrun-store-test");

const summaryFor = (root: string): AgentRunSummary =>
  ({
    agentAccount: "The basket never accepted the product.",
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
    coverage: { complete: false, executed: 2, total: 3, unexecuted: 1 },
    endedAt: "2026-09-04T00:02:00.000Z",
    flowSkillName: FlowSkillName.make("browse-catalogue"),
    inputs: [{ name: "product", value: "Mug" }],
    outcome: "ended-early",
    runId,
    schemaVersion: 2,
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
        doneWhen: "the page shows the expected outcome.",
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
        doneWhen: "the page shows the expected outcome.",
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
        doneWhen: "the page shows the expected outcome.",
        endedAt: null,
        execution: "unexecuted",
        index: 2,
        name: "Check out",
        startedAt: null,
      },
    ],
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
  "reads a Run Summary persisted while Runs had wall-clock ceilings",
  () =>
    Effect.gen(function* readLegacySummary() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-store-",
      });
      const current = summaryFor(root);
      // Written the way a Runner with ceilings wrote it: a `ceilings` block,
      // a `timed-out` outcome, and the interrupted Step marked `timed-out`.
      const legacy = {
        ...current,
        ceilings: { extensions: 1, runMs: 900_000, stepMs: 120_000 },
        outcome: "timed-out",
        steps: current.steps.map((step) =>
          step.index === 2
            ? { ...step, confirmation: false, execution: "timed-out" }
            : step
        ),
        timeline: [
          {
            actor: "agent",
            at: "2026-09-04T00:01:00.000Z",
            description: "Add the product to the basket",
            detail: "The basket did not change.",
            dispatched: true,
            effect: { kind: "none" },
            id: "attempt-1",
            outcome: "failed",
          },
        ],
        tracePath: "artifacts/historical.trace.zip",
        videoPath: "artifacts/historical.webm",
      };
      const directory = path.join(root, AGENT_RUNS_DIRECTORY, current.runId);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(directory, "summary.json"),
        JSON.stringify(legacy)
      );
      // A Catalog Root may still carry the ceiling policy it once declared.
      yield* fileSystem.writeFileString(
        path.join(root, "catalog.json"),
        JSON.stringify({
          agentRunCeilings: { runCeilingMs: 60_000, stepCeilingMs: 5000 },
        })
      );

      const read = yield* Effect.gen(function* readAgain() {
        const store = yield* AgentRunStore;
        return yield* store.read(current.runId);
      }).pipe(Effect.provide(layerFor(root)));

      expect(read.outcome).toBe("timed-out");
      if (read.schemaVersion !== 2) {
        return yield* Effect.die("Expected a historical step Run Summary.");
      }
      expect(read.ceilings).toEqual(legacy.ceilings);
      expect(read.steps[2]?.execution).toBe("timed-out");
      yield* Effect.gen(function* rewriteLegacySummary() {
        const store = yield* AgentRunStore;
        yield* store.write(read);
      }).pipe(Effect.provide(layerFor(root)));
      const persisted = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "summary.json"))
      );
      expect(persisted).toEqual(legacy);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "round-trips task history, composed inputs, findings, and browser artifacts",
  () =>
    Effect.gen(function* persistTaskRun() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-task-run-",
      });
      yield* Effect.gen(function* writeTask() {
        const store = yield* AgentRunStore;
        yield* store.write(taskRunSummary);
      }).pipe(Effect.provide(layerFor(root)));
      yield* Effect.gen(function* readTaskFromAnotherProcess() {
        const store = yield* AgentRunStore;
        expect(yield* store.read(taskRunSummary.runId)).toEqual(taskRunSummary);
        expect(yield* store.videoFile(taskRunSummary.runId)).toBe(
          path.join(
            root,
            AGENT_RUNS_DIRECTORY,
            taskRunSummary.runId,
            "run.webm"
          )
        );
      }).pipe(Effect.provide(layerFor(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("persists an unassessed skill-free task after process exit", () =>
  Effect.gen(function* persistUnassessedTask() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-task-run-",
    });
    yield* Effect.gen(function* roundTrip() {
      const store = yield* AgentRunStore;
      const summary = {
        ...taskRunSummary,
        assessment: null,
        findings: [],
        inputs: [],
        outcome: "process-exited" as const,
        referencedSkills: [],
        variables: [],
      };
      yield* store.write(summary);
      expect(yield* store.read(summary.runId)).toEqual(summary);
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("contains task video paths within the Run directory", () =>
  Effect.gen(function* containTaskVideo() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-task-run-",
    });
    yield* Effect.gen(function* escapedVideo() {
      const store = yield* AgentRunStore;
      yield* store.write({
        ...taskRunSummary,
        videoPath: "../another-run/run.webm",
      });
      expect(yield* store.videoFile(taskRunSummary.runId)).toBeNull();
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "reports invalid task data before overwriting an existing summary",
  () =>
    Effect.gen(function* preserveValidTask() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-task-run-",
      });
      yield* Effect.gen(function* refuseInvalidTask() {
        const store = yield* AgentRunStore;
        yield* store.write(taskRunSummary);
        const failure = yield* Effect.flip(
          store.write({
            ...taskRunSummary,
            requestedTask: "",
          })
        );
        expect(failure.code).toBe("agent_run_invalid");
        expect(yield* store.read(taskRunSummary.runId)).toEqual(taskRunSummary);
      }).pipe(Effect.provide(layerFor(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
