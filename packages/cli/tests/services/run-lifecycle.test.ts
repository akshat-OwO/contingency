import path from "node:path";

import {
  AgentSessionSnapshot,
  FlowSkillName,
  OperationId,
  TaskAgentRunState,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Scope } from "effect";

import {
  AgentRunStore,
  makeAgentRunStoreLayer,
} from "../../src/services/agent-run-store.ts";
import {
  endTaskRun,
  makeRunFinalizationState,
  makeRunLifecycle,
} from "../../src/services/run-lifecycle.ts";
import type { RunFinalizationRecord } from "../../src/services/run-lifecycle.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const operation = (name: string) => OperationId.make(name);
const at = "2026-10-03T00:00:00.000Z";
const runningTask = () =>
  Schema.decodeUnknownSync(TaskAgentRunState)({
    ...taskRunSummary,
    lastAgentActivityAt: at,
    lifecycle: { phase: "running" },
  });
const lifecycle = makeRunLifecycle({
  fileSystem: undefined,
  now: () => new Date(at),
  runStore: undefined,
  runVideoRenderer: undefined,
  teachingRecordingStore: undefined,
});
const report = {
  evidence: [{ id: "snapshot-cart", kind: "snapshot" as const }],
  explanation: "The cart failed, and investigation can continue.",
  outcome: "not-working" as const,
};
const evidence = {
  attempts: new Set(["attempt-cart"]),
  snapshots: new Set(["snapshot-cart"]),
};

it.effect(
  "assessments and findings preserve a live Run and validate owned evidence",
  () =>
    Effect.gen(function* assessAndRecover() {
      const run = runningTask();
      const invalid = yield* Effect.flip(
        lifecycle.assess(
          run,
          { ...report, evidence: [{ id: "foreign", kind: "snapshot" }] },
          false,
          evidence,
          at
        )
      );
      expect(invalid.code).toBe("agent_session_invalid");
      const assessed = yield* lifecycle.assess(
        run,
        report,
        false,
        evidence,
        at
      );
      expect(assessed.lifecycle).toEqual({ phase: "running" });
      const found = yield* lifecycle.assess(
        assessed,
        report,
        true,
        evidence,
        at
      );
      expect(found.assessment).toEqual(assessed.assessment);
      expect(found.findings).toHaveLength(run.findings.length + 1);
      expect(found.lifecycle).toEqual({ phase: "running" });
      const recovered = yield* lifecycle.assess(
        found,
        { ...report, outcome: "working" },
        false,
        evidence,
        at
      );
      expect(recovered.assessment?.outcome).toBe("working");
      expect(recovered.findings).toEqual(found.findings);
    })
);

it.effect(
  "task redirection preserves findings and replaces inputs only within their skill",
  () =>
    Effect.gen(function* redirectTask() {
      const run = runningTask();
      const updated = yield* lifecycle.update(
        run,
        Effect.succeed({
          inputs: [
            {
              flowSkillName: FlowSkillName.make("browse-catalogue"),
              name: "product",
              value: "Cup",
            },
          ],
          instruction: "Inspect the mug without checkout.",
          skills: [],
        })
      );
      expect(updated.run.assessment).toBeNull();
      expect(updated.run.findings).toEqual(run.findings);
      expect(updated.run.instructions.at(-1)?.instruction).toBe(
        "Inspect the mug without checkout."
      );
      expect(updated.run.inputs).toEqual([
        { flowSkillName: "browse-catalogue", name: "product", value: "Cup" },
        { flowSkillName: "update-cart", name: "product", value: "Blue mug" },
      ]);
      const inputOnly = yield* lifecycle.update(
        run,
        Effect.succeed({ inputs: [], skills: [] })
      );
      expect(inputOnly.run.assessment).toEqual(run.assessment);
    })
);

const dryTask = () => ({
  ...runningTask(),
  purpose: {
    flowSkillName: FlowSkillName.make("browse-catalogue"),
    kind: "dry-run" as const,
    recordingId: TeachingRecordingId.make("recording-lifecycle"),
    takeoverOccurred: false,
  },
});

it.effect(
  "Dry Run reports require completeness and updates reject before preparation",
  () =>
    Effect.gen(function* dryRunContract() {
      const run = dryTask();
      const invalid = yield* Effect.flip(
        lifecycle.assess(run, report, false, evidence, at)
      );
      expect(invalid.message).toContain("outcomeComplete");
      const found = yield* lifecycle.assess(run, report, true, evidence, at);
      expect(found.findings).toHaveLength(run.findings.length + 1);
      const refused = yield* Effect.flip(
        lifecycle.update(run, Effect.die("Preparation must not run."))
      );
      expect(refused.code).toBe("agent_session_invalid");
    })
);

const snapshotFor = (run: TaskAgentRunState) =>
  Schema.decodeUnknownSync(AgentSessionSnapshot)({
    activity: "run",
    boundary: null,
    captureState: null,
    clientName: "test",
    clientVersion: "1",
    controller: "agent",
    createdAt: at,
    currentUrl: "http://localhost/shop.html",
    dryRun: null,
    flowSkillName: null,
    id: taskRunSummary.sessionId,
    interruptedAction: null,
    ownerProcessId: "mcp-lifecycle-test",
    phase: "running",
    recordingId: null,
    run,
    takeover: null,
    teaching: null,
    timeline: taskRunSummary.timeline,
    updatedAt: at,
    viewUrl: "http://localhost/",
  });

const finalizationRecord = (run: TaskAgentRunState, directory: string) =>
  Effect.gen(function* makeRecord() {
    const scope = yield* Scope.make();
    const record: RunFinalizationRecord = {
      artifactDirectory: directory,
      dryRunControl: { hadTakeover: false },
      finalized: makeRunFinalizationState(),
      footage: undefined,
      runTimeline: taskRunSummary.timeline,
      scope,
      snapshot: snapshotFor(run),
      supplied: new Map([["secret", "private"]]),
      traceFile: path.join(directory, "run.trace.zip"),
      videoFile: path.join(directory, "run.webm"),
    };
    return record;
  });

it.effect(
  "persistence and account retries retain one sealed summary and its artifacts",
  () =>
    Effect.gen(function* retryFinalization() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-run-lifecycle-",
      });
      yield* Effect.gen(function* exercisePersistence() {
        const store = yield* AgentRunStore;
        const directory = yield* store.prepare(taskRunSummary.runId);
        const record = yield* finalizationRecord(runningTask(), directory);
        const seals: string[] = [];
        yield* Scope.addFinalizer(
          record.scope,
          Effect.gen(function* sealArtifacts() {
            seals.push("sealed");
            yield* files.writeFileString(record.traceFile ?? "", "trace");
            yield* files.writeFileString(record.videoFile ?? "", "video");
          }).pipe(Effect.orDie)
        );
        const module = makeRunLifecycle({
          fileSystem: files,
          now: () => new Date(at),
          runStore: store,
          runVideoRenderer: undefined,
          teachingRecordingStore: undefined,
        });
        let { snapshot } = record;
        const mutate = (
          change: (current: AgentSessionSnapshot) => AgentSessionSnapshot
        ) =>
          Effect.sync(() => {
            snapshot = change(snapshot);
            return snapshot;
          });
        const summaryFile = path.join(directory, "summary.json");
        yield* files.makeDirectory(summaryFile);
        yield* Effect.flip(module.finalize(record, mutate));
        expect(record.finalized.persisted).toBe(false);
        expect(record.supplied.size).toBe(0);
        expect(snapshot.phase).toBe("closed");
        yield* files.remove(summaryFile, { recursive: true });
        const summary = yield* module.finalize({ ...record, snapshot }, mutate);
        expect(record.finalized.persisted).toBe(true);
        expect(summary.tracePath).toBe("run.trace.zip");
        expect(summary.videoPath).toBe("run.webm");
        expect(summary.timeline).toHaveLength(taskRunSummary.timeline.length);
        expect(yield* store.read(summary.runId)).toEqual(summary);
        expect(yield* module.finalize({ ...record, snapshot }, mutate)).toEqual(
          summary
        );
        yield* files.remove(summaryFile);
        yield* files.makeDirectory(summaryFile);
        yield* Effect.flip(
          module.finalize({ ...record, snapshot }, mutate, "Closing account")
        );
        expect(record.finalized.summary).toEqual(summary);
        yield* files.remove(summaryFile, { recursive: true });
        const amended = yield* module.finalize(
          { ...record, snapshot },
          mutate,
          "Closing account"
        );
        expect(amended).toHaveProperty("agentAccount", "Closing account");
        expect(yield* store.read(summary.runId)).toEqual(amended);
        expect(seals).toEqual(["sealed"]);
        expect(yield* files.readFileString(record.traceFile ?? "")).toBe(
          "trace"
        );
      }).pipe(Effect.provide(makeAgentRunStoreLayer({ root: () => root })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([
  {
    assessed: true,
    complete: true,
    ending: "completed" as const,
    missingScan: true,
    passes: false,
    takeover: false,
  },
  {
    assessed: true,
    complete: true,
    ending: "completed" as const,
    passes: true,
    takeover: false,
  },
  {
    assessed: true,
    complete: false,
    ending: "completed" as const,
    passes: false,
    takeover: false,
  },
  {
    assessed: true,
    complete: true,
    ending: "completed" as const,
    passes: false,
    takeover: true,
  },
  {
    assessed: true,
    complete: true,
    ending: "user-closed" as const,
    passes: false,
    takeover: false,
  },
  {
    assessed: true,
    complete: true,
    ending: "process-exited" as const,
    passes: false,
    takeover: false,
  },
  {
    assessed: false,
    complete: true,
    ending: "completed" as const,
    passes: false,
    takeover: false,
  },
  {
    assessed: true,
    complete: true,
    ending: "interrupted" as const,
    passes: false,
    takeover: false,
  },
])(
  "qualifies a Dry Run only from its completed report: %j",
  ({
    assessed: hasAssessment,
    complete,
    takeover,
    ending,
    passes,
    ...scenario
  }) =>
    Effect.gen(function* qualifyDryRun() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-dry-lifecycle-",
      });
      yield* Effect.gen(function* exerciseQualification() {
        const store = yield* TeachingRecordingStore;
        const baseRun = dryTask();
        const run =
          "missingScan" in scenario
            ? {
                ...baseRun,
                scanReports: [],
                scanRequirements: [
                  {
                    flowSkillName: baseRun.purpose.flowSkillName,
                    id: "required-load",
                    mode: "reload" as const,
                    when: "The catalog opens",
                  },
                ],
              }
            : baseRun;
        const { recordingId } = run.purpose;
        yield* store.begin({
          emulation: run.startingEmulation,
          flowSkillName: run.purpose.flowSkillName,
          operationId: operation("begin"),
          recordingId,
          sessionId: taskRunSummary.sessionId,
        });
        yield* store.start({
          emulation: run.startingEmulation,
          operationId: operation("start"),
          recordingId,
        });
        yield* store.stop({
          artifacts: [],
          operationId: operation("stop"),
          recordingId,
        });
        yield* store.startLearning({
          operationId: operation("learn"),
          recordingId,
        });
        yield* store.saveSkill({
          claimOperationId: operation("learn"),
          files: ["SKILL.md"],
          operationId: operation("save"),
          recordingId,
          skillPath: "browse-catalogue/SKILL.md",
        });
        yield* store.startDryRun({
          inputs: [],
          operationId: operation("dry"),
          recordingId,
          sessionId: taskRunSummary.sessionId,
        });
        const assessed = yield* lifecycle.assess(
          run,
          { ...report, outcome: "working", outcomeComplete: complete },
          false,
          evidence,
          at
        );
        const ended = endTaskRun(
          hasAssessment ? assessed : { ...run, assessment: null },
          ending,
          at
        );
        const directory = path.join(store.directory(recordingId), "dry-run");
        yield* files.makeDirectory(directory, { recursive: true });
        const base = yield* finalizationRecord(ended, directory);
        const record = {
          ...base,
          dryRunControl: { hadTakeover: takeover },
          snapshot: Schema.decodeUnknownSync(AgentSessionSnapshot)({
            ...base.snapshot,
            dryRun: {
              flowSkillName: run.purpose.flowSkillName,
              recordingId,
              startedAt: at,
            },
          }),
        };
        const module = makeRunLifecycle({
          fileSystem: files,
          now: () => new Date(at),
          runStore: undefined,
          runVideoRenderer: undefined,
          teachingRecordingStore: store,
        });
        let { snapshot } = record;
        const mutate = (
          change: (current: AgentSessionSnapshot) => AgentSessionSnapshot
        ) =>
          Effect.sync(() => {
            snapshot = change(snapshot);
            return snapshot;
          });
        const summary = yield* module.finalize(record, mutate);
        expect(summary.outcome).toBe(ending);
        expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
          passes ? "dry-run-passed" : "dry-run-failed"
        );
        expect(yield* files.exists(path.join(directory, "summary.json"))).toBe(
          true
        );
        expect(yield* files.exists(store.directory(recordingId))).toBe(true);
      }).pipe(
        Effect.provide(
          makeTeachingRecordingStoreLayer({
            now: () => new Date(at),
            root: () => root,
          })
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
