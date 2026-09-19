import path from "node:path";

import { AgentRunId, FlowSkillName, OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import {
  AGENT_RUNS_DIRECTORY,
  AgentRunStore,
} from "../../src/services/agent-run-store.ts";
import { agentProcessLayer, runTool, sessionTool } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/**
 * A two-step journey over the delivery fixture. The Run is driven by
 * assessments alone: what is under test is when a Run's evidence becomes
 * reachable, not whether the agent can reach a control.
 */
const READ_DELIVERY_SKILL = `---
name: read-delivery
description: Read the shop's delivery picker and confirm it offers a manual choice. Use when the delivery section must be checked.
---

# Read the delivery picker

1. Choose the button named "Choose delivery area". Done when: a heading named "Delivery area" is on the page.
2. Choose the button named "Select manually". Done when: a textbox named "Search for your delivery area" is on the page.
`;

const saveSkill = (root: string) =>
  Effect.gen(function* writeFlowSkillPackage() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.join(root, "read-delivery");
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory, "SKILL.md"),
      READ_DELIVERY_SKILL
    );
  });

/** One Agent Step, assessed against a Browser Snapshot this Step produced. */
const assessActiveStep = (
  sessionId: AgentSessionId,
  outcome: "working" | "not-working",
  operationId: string
) =>
  Effect.gen(function* assessOneStep() {
    const observed = yield* sessionTool("agent_browser_snapshot", {
      sessionId,
    });
    return yield* runTool("agent_run_step_assess", {
      evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
      explanation: "The delivery picker was on the page.",
      operationId: OperationId.make(operationId),
      outcome,
      sessionId,
    });
  });

it.live(
  "persists a Run Summary the moment the last Agent Step is assessed",
  () =>
    Effect.gen(function* persistOnFinalAssessment() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-summary-",
      });
      const fixtures = yield* fixtureServer;
      yield* saveSkill(root);

      const runId = yield* Effect.scoped(
        Effect.gen(function* runTheJourney() {
          const started = yield* runTool("agent_flow_skill_run_start", {
            clientName: "integration-runner",
            clientVersion: "1.0.0",
            flowSkillName: FlowSkillName.make("read-delivery"),
            inputs: [],
            operationId: OperationId.make("summary-run-start"),
            url: fixtures.url("delivery.html"),
          });
          const { run } = started;
          if (run === null) {
            return yield* Effect.die("The Run did not start.");
          }
          expect(run.steps).toHaveLength(2);

          yield* assessActiveStep(started.id, "working", "summary-assess-1");
          const ended = yield* assessActiveStep(
            started.id,
            "working",
            "summary-assess-2"
          );

          // Assessing the last ordered Step ends the Run by itself.
          expect(ended.run?.activeStepIndex).toBeNull();
          expect(ended.run?.outcome).toBe("completed");
          expect(ended.run?.coverage.complete).toBe(true);

          // The Summary exists without any further call, and `open_run` in the
          // process that produced it resolves a view URL.
          const opened = yield* runTool("open_run", { runId: run.runId });
          expect(opened.summary.outcome).toBe("completed");
          expect(opened.summary.runId).toBe(run.runId);
          expect(opened.viewUrl).toContain(run.runId);
          expect(
            opened.summary.steps.map((step) => step.assessment?.outcome)
          ).toEqual(["working", "working"]);
          // Nothing in the Summary is left for a later call to fill in.
          expect(opened.summary.videoPath).not.toBeUndefined();
          expect(opened.summary.tracePath).not.toBeUndefined();

          // The recovery path still works and writes no second Summary: it
          // answers with the one the Run already persisted, and records the
          // closing account the agent offers with it.
          const completed = yield* runTool("agent_run_complete", {
            agentAccount: "Both Agent Steps worked.",
            operationId: OperationId.make("summary-complete"),
            sessionId: started.id,
          });
          expect(completed.runId).toBe(run.runId);
          expect(completed.agentAccount).toBe("Both Agent Steps worked.");
          expect(completed.outcome).toBe("completed");
          return run.runId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      // A later process reads nothing but the persisted package.
      yield* Effect.scoped(
        Effect.gen(function* readInALaterProcess() {
          const store = yield* AgentRunStore;
          const summary = yield* store.read(runId);
          expect(summary.outcome).toBe("completed");
          expect(summary.agentAccount).toBe("Both Agent Steps worked.");
          expect(
            yield* fileSystem.exists(
              path.join(root, AGENT_RUNS_DIRECTORY, runId, "summary.json")
            )
          ).toBe(true);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("persists a Run Summary a terminal Agent Assessment ended", () =>
  Effect.gen(function* persistOnTerminalVerdict() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-summary-early-",
    });
    const fixtures = yield* fixtureServer;
    yield* saveSkill(root);

    yield* Effect.scoped(
      Effect.gen(function* stopOnTheFirstStep() {
        const started = yield* runTool("agent_flow_skill_run_start", {
          clientName: "integration-runner",
          clientVersion: "1.0.0",
          flowSkillName: FlowSkillName.make("read-delivery"),
          inputs: [],
          operationId: OperationId.make("early-run-start"),
          url: fixtures.url("delivery.html"),
        });
        const { run } = started;
        if (run === null) {
          return yield* Effect.die("The Run did not start.");
        }

        const ended = yield* assessActiveStep(
          started.id,
          "not-working",
          "early-assess-1"
        );
        expect(ended.run?.outcome).toBe("ended-early");

        const opened = yield* runTool("open_run", { runId: run.runId });
        expect(opened.summary.outcome).toBe("ended-early");
        expect(opened.summary.coverage).toEqual({
          complete: false,
          executed: 1,
          total: 2,
          unexecuted: 1,
        });
        expect(opened.summary.steps.map((step) => step.execution)).toEqual([
          "assessed",
          "unexecuted",
        ]);
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("reports a run id that never existed as a missing Run", () =>
  Effect.gen(function* openAnAbsentRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-run-summary-absent-",
    });

    yield* Effect.scoped(
      Effect.gen(function* openNothing() {
        const opened = yield* Effect.result(
          runTool("open_run", { runId: AgentRunId.make("agentrun-absent") })
        );
        expect(Result.isFailure(opened)).toBe(true);
        if (Result.isFailure(opened)) {
          expect(JSON.stringify(opened.failure)).toContain(
            "agent_run_not_found"
          );
        }
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "writes the Run Summary on completion when the ending write failed",
  () =>
    Effect.gen(function* retryAFailedWrite() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-summary-retry-",
      });
      const fixtures = yield* fixtureServer;
      yield* saveSkill(root);

      yield* Effect.scoped(
        Effect.gen(function* endAgainstABlockedCatalogRoot() {
          const started = yield* runTool("agent_flow_skill_run_start", {
            clientName: "integration-runner",
            clientVersion: "1.0.0",
            flowSkillName: FlowSkillName.make("read-delivery"),
            inputs: [],
            operationId: OperationId.make("retry-run-start"),
            url: fixtures.url("delivery.html"),
          });
          const { run } = started;
          if (run === null) {
            return yield* Effect.die("The Run did not start.");
          }
          // A directory where the Summary file belongs: the Run ends against a
          // Catalog Root that cannot take its write.
          const summaryFile = path.join(
            root,
            AGENT_RUNS_DIRECTORY,
            run.runId,
            "summary.json"
          );
          yield* fileSystem.makeDirectory(summaryFile, { recursive: true });

          yield* assessActiveStep(started.id, "working", "retry-assess-1");
          const ended = yield* assessActiveStep(
            started.id,
            "working",
            "retry-assess-2"
          );
          // The Run is over either way. Only its Summary is missing.
          expect(ended.run?.outcome).toBe("completed");
          const absent = yield* Effect.result(
            runTool("open_run", { runId: run.runId })
          );
          expect(Result.isFailure(absent)).toBe(true);

          // The recovery path is the whole point of tolerating the failed write:
          // completing the ended Run must write the Summary, not answer with an
          // in-memory one the Catalog Root has never seen.
          yield* fileSystem.remove(summaryFile, { recursive: true });
          // No closing account, so nothing about the Summary has changed:
          // only the unwritten Summary itself can send this to the store.
          const completed = yield* runTool("agent_run_complete", {
            operationId: OperationId.make("retry-complete"),
            sessionId: started.id,
          });
          expect(completed.outcome).toBe("completed");
          const opened = yield* runTool("open_run", { runId: run.runId });
          expect(opened.summary.outcome).toBe("completed");
          expect(opened.summary.agentAccount).toBeUndefined();
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "writes the closing account on a retry when its first write failed",
  () =>
    Effect.gen(function* retryAFailedAmend() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-run-summary-amend-",
      });
      const fixtures = yield* fixtureServer;
      yield* saveSkill(root);

      yield* Effect.scoped(
        Effect.gen(function* amendAgainstABlockedCatalogRoot() {
          const started = yield* runTool("agent_flow_skill_run_start", {
            clientName: "integration-runner",
            clientVersion: "1.0.0",
            flowSkillName: FlowSkillName.make("read-delivery"),
            inputs: [],
            operationId: OperationId.make("amend-run-start"),
            url: fixtures.url("delivery.html"),
          });
          const { run } = started;
          if (run === null) {
            return yield* Effect.die("The Run did not start.");
          }

          yield* assessActiveStep(started.id, "working", "amend-assess-1");
          yield* assessActiveStep(started.id, "working", "amend-assess-2");
          // The Run ended on its own and its first write landed.
          const stored = yield* runTool("open_run", { runId: run.runId });
          expect(stored.summary.agentAccount).toBeUndefined();

          // A directory where the Summary file belongs: the amend cannot be
          // written, so the closing account never reaches the Catalog Root.
          const summaryFile = path.join(
            root,
            AGENT_RUNS_DIRECTORY,
            run.runId,
            "summary.json"
          );
          yield* fileSystem.remove(summaryFile);
          yield* fileSystem.makeDirectory(summaryFile, { recursive: true });
          const blocked = yield* Effect.result(
            runTool("agent_run_complete", {
              agentAccount: "The delivery date was read.",
              operationId: OperationId.make("amend-complete-blocked"),
              sessionId: started.id,
            })
          );
          expect(Result.isFailure(blocked)).toBe(true);

          // The failed amend left the account unrecorded, so a retry must
          // write it rather than treat the Summary as already amended.
          yield* fileSystem.remove(summaryFile, { recursive: true });
          const completed = yield* runTool("agent_run_complete", {
            agentAccount: "The delivery date was read.",
            operationId: OperationId.make("amend-complete-retry"),
            sessionId: started.id,
          });
          expect(completed.agentAccount).toBe("The delivery date was read.");
          const opened = yield* runTool("open_run", { runId: run.runId });
          expect(opened.summary.agentAccount).toBe(
            "The delivery date was read."
          );
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
