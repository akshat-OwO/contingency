import path from "node:path";

import { FlowSkillName, OperationId } from "@contingency/protocol";
import type {
  AgentSessionSnapshot,
  TaskAgentRunState,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  awaitRunVideo,
  catalogTool,
  findNode,
  runTool,
  resolveBoundary,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const taskRun = (snapshot: AgentSessionSnapshot): TaskAgentRunState => {
  if (snapshot.run === null || !("schemaVersion" in snapshot.run)) {
    throw new Error("Expected a task Run.");
  }
  return snapshot.run;
};
const operation = OperationId.make;
const saveSkill = (
  root: string,
  name: string,
  width = 640,
  host = "127.0.0.1"
) =>
  Effect.gen(function* saveVerifiedSkill() {
    const files = yield* FileSystem.FileSystem;
    const directory = path.join(root, name);
    yield* files.makeDirectory(path.join(directory, "references"), {
      recursive: true,
    });
    yield* files.writeFileString(
      path.join(directory, "SKILL.md"),
      `---
name: ${name}
description: Use ${name} to investigate the cart.
hosts:
  - ${host}
emulation:
  viewport: ${width}x480@1
inputs:
  - name: area
  - name: PASSWORD
  - name: UNUSED
---

# Cart investigation

1. Add an anvil to the cart. Done when: the cart contains one anvil.
2. Enter {{PASSWORD}} only if requested. Done when: the user is signed in.
`
    );
    yield* files.writeFileString(
      path.join(directory, "references/verification.md"),
      "- Verified: 2026-10-01T00:00:00.000Z\n"
    );
  });

it.live(
  "authorizes task exploration, later requested hosts, and exactly one confirmed action attempt",
  () =>
    Effect.gen(function* taskAuthority() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-authority-",
      });
      const fixture = yield* fixtureServer;
      yield* saveSkill(root, "later-skill", 640, "localhost");
      yield* Effect.scoped(
        Effect.gen(function* checkAuthority() {
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: operation("authority-start"),
            referencedSkills: [],
            requestedTask: "Investigate the cart",
            url: fixture.url("task-session.html"),
          });
          const sessionId = started.id;
          const action = {
            type: "navigate" as const,
            url: fixture.url("task-session.html"),
          };
          const unrelated = yield* sessionTool("agent_browser_act", {
            action,
            intent: { objective: "Do an unrelated task", objectiveKind: "new" },
            operationId: operation("authority-unrelated"),
            sessionId,
          });
          expect(unrelated.intervention?.reason).toBe("objective");
          yield* resolveBoundary({
            boundaryId: unrelated.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "authority-refuse-objective",
            sessionId,
          });
          const explored = yield* sessionTool("agent_browser_act", {
            action,
            intent: {
              objective:
                "Explore another route to understand this shopping cart",
              objectiveKind: "task",
            },
            operationId: operation("authority-explore"),
            sessionId,
          });
          expect(explored.entry.outcome).toBe("completed");
          const nextHost = {
            ...action,
            url: action.url.replace("127.0.0.1", "localhost"),
          };
          const refused = yield* sessionTool("agent_browser_act", {
            action: nextHost,
            operationId: operation("authority-host-before"),
            sessionId,
          });
          expect(refused.intervention?.reason).toBe("domain");
          expect(
            (yield* sessionTool("agent_session_get", { sessionId })).currentUrl
          ).toBe(action.url);
          yield* resolveBoundary({
            boundaryId: refused.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "authority-refuse-domain",
            sessionId,
          });
          yield* runTool("agent_run_update", {
            inputs: [],
            instruction: "Use the later skill too",
            operationId: operation("authority-request-skill"),
            referencedSkills: [FlowSkillName.make("later-skill")],
            sessionId,
          });
          const admitted = yield* sessionTool("agent_browser_act", {
            action: nextHost,
            operationId: operation("authority-host-after"),
            sessionId,
          });
          expect(admitted.entry.outcome).toBe("completed");
          const confirmedAction = {
            action: {
              ref: findNode(admitted.snapshot.nodes, "button", "Add anvil").ref,
              type: "click" as const,
            },
            intent: { irreversible: true },
            operationId: operation("authority-confirmed"),
            sessionId,
          };
          const paused = yield* sessionTool(
            "agent_browser_act",
            confirmedAction
          );
          expect(paused.intervention?.reason).toBe("confirmation");
          yield* resolveBoundary({
            boundaryId: paused.intervention?.id ?? "missing",
            decision: "allow",
            operationId: "authority-allow-attempt",
            sessionId,
          });
          const acted = yield* sessionTool(
            "agent_browser_act",
            confirmedAction
          );
          const replayed = yield* sessionTool(
            "agent_browser_act",
            confirmedAction
          );
          expect(replayed.entry.id).toBe(acted.entry.id);
          expect(
            acted.snapshot.nodes.some((node) =>
              node.name.includes("Cart has 1 items")
            )
          ).toBe(true);
          const retry = yield* sessionTool("agent_browser_act", {
            ...confirmedAction,
            operationId: operation("authority-fresh-attempt"),
          });
          expect(retry.intervention?.reason).toBe("confirmation");
          yield* resolveBoundary({
            boundaryId: retry.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "authority-refuse-retry",
            sessionId,
          });
          yield* runTool("agent_run_complete", {
            operationId: operation("authority-complete"),
            sessionId,
          });
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "keeps a zero-skill task live across failure, changed instructions, retry, and explicit completion",
  () =>
    Effect.gen(function* taskLifecycle() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-task-",
      });
      const fixture = yield* fixtureServer;
      const runId = yield* Effect.scoped(
        Effect.gen(function* runTask() {
          const request = {
            inputs: [],
            operationId: operation("task-start"),
            referencedSkills: [],
            requestedTask: "Investigate the cart",
            url: fixture.url("task-session.html"),
          };
          const started = yield* runTool("agent_run_start", request);
          const run = taskRun(started);
          expect(run).not.toHaveProperty("steps");
          expect(run).not.toHaveProperty("activeStepIndex");
          expect(started.pendingDecisions).toEqual([]);
          expect((yield* runTool("agent_run_start", request)).id).toBe(
            started.id
          );
          expect(
            (yield* Effect.flip(
              runTool("agent_run_start", {
                ...request,
                requestedTask: "Different task",
              })
            )).code
          ).toBe("agent_session_conflict");
          const snapshot = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          const foreignRun = yield* runTool("agent_run_start", {
            ...request,
            operationId: operation("foreign-task-start"),
          });
          const foreign = yield* sessionTool("agent_browser_snapshot", {
            sessionId: foreignRun.id,
          });
          expect(foreign.snapshotId).not.toBe(snapshot.snapshotId);
          const foreignReport = {
            evidence: [{ id: foreign.snapshotId, kind: "snapshot" as const }],
            explanation: "A different Run observed this page.",
            operationId: operation("task-correctable-evidence"),
            outcome: "working" as const,
            sessionId: started.id,
          };
          expect(
            (yield* Effect.flip(runTool("agent_run_assess", foreignReport)))
              .code
          ).toBe("agent_session_invalid");
          yield* runTool("agent_run_assess", {
            ...foreignReport,
            evidence: [{ id: snapshot.snapshotId, kind: "snapshot" }],
          });
          yield* runTool("agent_run_complete", {
            operationId: operation("foreign-task-complete"),
            sessionId: foreignRun.id,
          });
          const finding = {
            evidence: [{ id: snapshot.snapshotId, kind: "snapshot" as const }],
            explanation: "The cart is empty and needs investigation.",
            operationId: operation("task-finding"),
            outcome: "not-working" as const,
            sessionId: started.id,
          };
          const found = yield* runTool("agent_run_finding", finding);
          expect(taskRun(found).findings).toHaveLength(1);
          expect(taskRun(found).findings[0]).not.toHaveProperty(
            "outcomeComplete"
          );
          expect(
            taskRun(yield* runTool("agent_run_finding", finding)).findings
          ).toHaveLength(1);
          yield* runTool("agent_run_assess", {
            ...finding,
            operationId: operation("task-failed-assessment"),
          });
          const changed = yield* runTool("agent_run_update", {
            inputs: [],
            instruction: "Add an anvil and retry",
            operationId: operation("task-change"),
            referencedSkills: [],
            sessionId: started.id,
          });
          expect(taskRun(changed).assessment).toBeNull();
          expect(taskRun(changed).runId).toBe(run.runId);
          const action = {
            ref: findNode(snapshot.nodes, "button", "Add anvil").ref,
            type: "click" as const,
          };
          const acted = yield* sessionTool("agent_browser_act", {
            action,
            operationId: operation("task-retry"),
            sessionId: started.id,
          });
          expect(acted.entry.outcome).toBe("completed");
          expect(
            (yield* sessionTool("agent_browser_act", {
              action,
              operationId: operation("task-retry"),
              sessionId: started.id,
            })).entry.id
          ).toBe(acted.entry.id);
          const invalidEvidence = yield* Effect.flip(
            runTool("agent_run_assess", {
              ...finding,
              evidence: [{ id: "invented", kind: "snapshot" }],
              operationId: operation("task-invalid-evidence"),
            })
          );
          expect(invalidEvidence.code).toBe("agent_session_invalid");
          expect(invalidEvidence.message).not.toContain("outcomeComplete");
          const assessed = yield* runTool("agent_run_assess", {
            ...finding,
            evidence: [{ id: acted.entry.id, kind: "attempt" }],
            explanation: "The cart now contains one anvil.",
            operationId: operation("task-working"),
            outcome: "working",
          });
          expect(taskRun(assessed).lifecycle.phase).toBe("running");
          yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          const closing = {
            agentAccount: "Recovered and added the requested item.",
            operationId: operation("task-complete"),
            sessionId: started.id,
          };
          const summary = yield* runTool("agent_run_complete", closing);
          if (summary.schemaVersion !== 3) {
            return yield* Effect.die("Expected task summary.");
          }
          expect(summary.outcome).toBe("completed");
          expect(summary.assessment?.outcome).toBe("working");
          expect(summary.findings).toHaveLength(1);
          expect(summary.instructions).toHaveLength(1);
          expect(summary.tracePath).not.toBeNull();
          expect(summary.videoPath).toBe("run.webm");
          // The video plays the Run's actions in real time and fast-forwards
          // the gaps between them, from offset zero to the Run's end.
          const segments = summary.videoTimeMap?.segments ?? [];
          expect(segments.some(({ kind }) => kind === "real-time")).toBe(true);
          expect(segments[0]?.runFromMs).toBe(0);
          for (const [index, segment] of segments.entries()) {
            expect(segment.runFromMs).toBe(segments[index - 1]?.runToMs ?? 0);
          }
          const runDirectory = path.join(root, "agent-runs", run.runId);
          expect(yield* awaitRunVideo(runDirectory)).toEqual({
            condensed: true,
            state: "ready",
          });
          const artifacts = yield* files.readDirectory(runDirectory);
          expect(artifacts).toContain("run.webm");
          expect(artifacts).not.toContain("footage.webm");
          expect(artifacts).not.toContain("footage.json");
          expect(yield* runTool("agent_run_complete", closing)).toEqual(
            summary
          );
          expect(
            yield* files.readDirectory(path.join(root, "agent-runs", run.runId))
          ).toEqual(artifacts);
          expect((yield* runTool("agent_run_start", request)).phase).toBe(
            "closed"
          );
          return run.runId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
      const reopened = yield* Effect.scoped(
        runTool("open_run", { runId }).pipe(
          Effect.provide(agentProcessLayer(root))
        )
      );
      expect(reopened.summary.schemaVersion).toBe(3);
      expect(reopened.summary.runId).toBe(runId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "composes partial skills without resetting the cart or Emulation, and requests scoped inputs lazily",
  () =>
    Effect.gen(function* composeSkills() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-task-skills-",
      });
      const fixture = yield* fixtureServer;
      yield* saveSkill(root, "flow1");
      yield* saveSkill(root, "flow2", 390);
      yield* Effect.scoped(
        Effect.gen(function* composeRun() {
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: operation("compose-start"),
            referencedSkills: [FlowSkillName.make("flow1")],
            requestedTask:
              "Add an anvil using part of flow1, then investigate with flow2",
            url: fixture.url("task-session.html"),
          });
          expect(started.pendingDecisions).toEqual([]);
          const refusedHost = yield* Effect.flip(
            runTool("agent_run_start", {
              inputs: [],
              operationId: operation("compose-wrong-host"),
              referencedSkills: [FlowSkillName.make("flow1")],
              requestedTask: "Inspect another host",
              url: fixture
                .url("task-session.html")
                .replace("127.0.0.1", "localhost"),
            })
          );
          expect(refusedHost.message).toContain("127.0.0.1");
          expect(refusedHost.message).toContain("localhost");
          const session = yield* AgentSession;
          const before = yield* session.emulation(started.id);
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          yield* sessionTool("agent_browser_act", {
            action: {
              ref: findNode(observed.nodes, "button", "Add anvil").ref,
              type: "click",
            },
            operationId: operation("compose-cart"),
            sessionId: started.id,
          });
          for (const [role, name] of [
            ["button", "Sign in"],
            ["link", "Open help tab"],
          ] as const) {
            const current = yield* sessionTool("agent_browser_snapshot", {
              sessionId: started.id,
            });
            yield* sessionTool("agent_browser_act", {
              action: {
                ref: findNode(current.nodes, role, name).ref,
                type: "click",
              },
              operationId: operation(`compose-${name.replaceAll(" ", "-")}`),
              sessionId: started.id,
            });
          }
          const tabsBefore = yield* session.tabs(started.id);
          expect(tabsBefore).toHaveLength(2);
          expect(tabsBefore.map((tab) => tab.url)).toContain(
            fixture.url("task-session.html?tab=help")
          );
          const update = {
            inputs: [
              {
                flowSkillName: FlowSkillName.make("flow1"),
                name: "area",
                value: "one",
              },
              {
                flowSkillName: FlowSkillName.make("flow2"),
                name: "area",
                value: "two",
              },
            ],
            instruction: "Continue with flow2 and retain the cart",
            operationId: operation("compose-update"),
            referencedSkills: [FlowSkillName.make("flow2")],
            sessionId: started.id,
          };
          const updated = yield* runTool("agent_run_update", update);
          expect(taskRun(updated).runId).toBe(taskRun(started).runId);
          expect(taskRun(updated).inputs.map((input) => input.value)).toEqual([
            "one",
            "two",
          ]);
          expect(
            taskRun(yield* runTool("agent_run_update", update)).instructions
          ).toHaveLength(1);
          yield* files.remove(path.join(root, "flow1"), { recursive: true });
          yield* files.remove(path.join(root, "flow2"), { recursive: true });
          expect(yield* runTool("agent_run_update", update)).toEqual(updated);
          const redirected = yield* runTool("agent_run_update", {
            inputs: [],
            instruction:
              "Investigate the current cart without consulting another skill",
            operationId: operation("compose-redirect"),
            referencedSkills: [],
            sessionId: started.id,
          });
          expect(taskRun(redirected).instructions).toHaveLength(2);
          expect(yield* session.emulation(started.id)).toEqual(before);
          expect(
            (yield* session.tabs(started.id)).map((tab) => tab.tabId)
          ).toEqual(tabsBefore.map((tab) => tab.tabId));
          const [tab] = tabsBefore;
          if (tab === undefined) {
            return yield* Effect.die("No browser tab.");
          }
          const storage = yield* session.storage(
            started.id,
            tab.tabId,
            "local"
          );
          if (storage.kind === "cookies") {
            return yield* Effect.die("Expected origin storage.");
          }
          expect(storage.entries["fixture-account"]).toBe("signed-in");
          const cart = yield* session.storage(started.id, tab.tabId, "session");
          if (cart.kind === "cookies") {
            return yield* Effect.die("Expected session storage.");
          }
          expect(cart.entries.cart).toBe("1");
          const cookies = yield* session.storage(
            started.id,
            tab.tabId,
            "cookies"
          );
          if (cookies.kind !== "cookies") {
            return yield* Effect.die("Expected cookies.");
          }
          expect(
            cookies.cookies.some(
              (cookie) =>
                cookie.name === "fixture-login" && cookie.value === "active"
            )
          ).toBe(true);
          expect(updated.pendingDecisions).toEqual([]);
          yield* sessionTool("agent_browser_act", {
            action: { type: "navigate", url: fixture.url("recorder.html") },
            operationId: operation("compose-input-page"),
            sessionId: started.id,
          });
          for (const [flow, value] of [
            ["flow1", "private-one"],
            ["flow2", "private-two"],
          ] as const) {
            const requested = yield* runTool("agent_run_variable_request", {
              flowSkillName: FlowSkillName.make(flow),
              name: "PASSWORD",
              operationId: operation(`request-${flow}`),
              sessionId: started.id,
            });
            const pending = requested.pendingDecisions.find(
              (decision) => decision.variable?.flowSkillName === flow
            );
            if (pending === undefined) {
              return yield* Effect.die("Missing scoped Variable decision.");
            }
            const supply = {
              decision: "supply" as const,
              operationId: operation(`supply-${flow}`),
              pendingDecisionId: pending.pendingDecisionId,
              value,
            };
            const supplied = yield* catalogTool(
              "agent_pending_decision_resolve",
              supply
            );
            expect(JSON.stringify(supplied)).not.toContain(value);
            expect(
              yield* catalogTool("agent_pending_decision_resolve", supply)
            ).toEqual(supplied);
            const browser = yield* sessionTool("agent_browser_snapshot", {
              sessionId: started.id,
            });
            const entered = yield* sessionTool("agent_variable_enter", {
              flowSkillName: flow,
              name: "PASSWORD",
              operationId: operation(`enter-${flow}`),
              ref: findNode(browser.nodes, "textbox", "Password").ref,
              sessionId: started.id,
            });
            expect(entered.entry.outcome).toBe("completed");
            expect(JSON.stringify(entered)).not.toContain(value);
          }
          const final = yield* sessionTool("agent_session_get", {
            sessionId: started.id,
          });
          expect(
            taskRun(final)
              .variables.filter((variable) => variable.name === "UNUSED")
              .every((variable) => !variable.supplied)
          ).toBe(true);
          const summary = yield* runTool("agent_run_complete", {
            operationId: operation("compose-complete"),
            sessionId: started.id,
          });
          expect(JSON.stringify(summary)).not.toContain("private-one");
          expect(JSON.stringify(summary)).not.toContain("private-two");
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "persists user closure and owning-process exit without inventing a task assessment",
  () =>
    Effect.gen(function* externalEndings() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-task-close-",
      });
      const fixture = yield* fixtureServer;
      for (const ending of ["user-closed", "process-exited"] as const) {
        const runId = yield* Effect.scoped(
          Effect.gen(function* endTask() {
            const started = yield* runTool("agent_run_start", {
              inputs: [],
              operationId: operation(`start-${ending}`),
              referencedSkills: [],
              requestedTask: "Investigate",
              url: fixture.url("stateful.html"),
            });
            if (ending === "user-closed") {
              yield* sessionTool("agent_session_close", {
                operationId: operation("user-close"),
                sessionId: started.id,
              });
            }
            return taskRun(started).runId;
          }).pipe(Effect.provide(agentProcessLayer(root)))
        );
        const opened = yield* Effect.scoped(
          runTool("open_run", { runId }).pipe(
            Effect.provide(agentProcessLayer(root))
          )
        );
        expect(opened.summary.outcome).toBe(ending);
        if (opened.summary.schemaVersion !== 3) {
          return yield* Effect.die("Expected task summary.");
        }
        expect(opened.summary.assessment).toBeNull();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "retries failed task-summary persistence and a later closing account without resealing evidence",
  () =>
    Effect.gen(function* retryPersistence() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-task-retry-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* runRetry() {
          const started = yield* runTool("agent_run_start", {
            inputs: [],
            operationId: operation("persist-start"),
            referencedSkills: [],
            requestedTask: "Inspect the cart",
            url: fixture.url("task-session.html"),
          });
          const directory = path.join(
            root,
            "agent-runs",
            taskRun(started).runId
          );
          const summaryFile = path.join(directory, "summary.json");
          yield* files.makeDirectory(summaryFile);
          const closing = {
            operationId: operation("persist-complete"),
            sessionId: started.id,
          };
          yield* Effect.flip(runTool("agent_run_complete", closing));
          expect(
            (yield* sessionTool("agent_session_get", { sessionId: started.id }))
              .phase
          ).toBe("closed");
          yield* files.remove(summaryFile, { recursive: true });
          const summary = yield* runTool("agent_run_complete", closing);
          expect(summary.outcome).toBe("completed");
          const traceBefore = yield* files.readFile(
            path.join(directory, summary.tracePath ?? "missing")
          );
          yield* files.remove(summaryFile);
          yield* files.makeDirectory(summaryFile);
          const amendment = {
            ...closing,
            agentAccount: "Inspected the existing cart.",
            operationId: operation("persist-account"),
          };
          yield* Effect.flip(runTool("agent_run_complete", amendment));
          yield* files.remove(summaryFile, { recursive: true });
          const amended = yield* runTool("agent_run_complete", amendment);
          if (amended.schemaVersion !== 3) {
            return yield* Effect.die("Expected task summary.");
          }
          expect(amended.agentAccount).toBe(amendment.agentAccount);
          expect(
            (yield* runTool("open_run", { runId: summary.runId })).summary
          ).toEqual(amended);
          expect(
            yield* files.readFile(
              path.join(directory, summary.tracePath ?? "missing")
            )
          ).toEqual(traceBefore);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
