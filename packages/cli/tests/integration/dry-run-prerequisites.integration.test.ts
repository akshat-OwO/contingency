import path from "node:path";

import { FlowSkillName, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { TeachingRecordingStore } from "../../src/services/teaching-recording-store.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  runTool,
  resolveBoundary,
  sessionTool,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const operation = OperationId.make;

it.live(
  "fixes Dry Run prerequisites at startup and isolates private values, replacement, and fresh retries",
  () =>
    Effect.gen(function* prerequisiteDryRun() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-prerequisite-",
      });
      const fixture = yield* fixtureServer;
      for (const name of ["login", "location", "unverified"]) {
        yield* files.makeDirectory(path.join(root, name, "references"), {
          recursive: true,
        });
        yield* files.writeFileString(
          path.join(root, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Prepare ${name}.\ninputs:\n  - area\n  - PASSWORD\nhosts:\n  - localhost\nemulation:\n  viewport: 390x844@1\n---\n\n1. Use {{area}} and {{PASSWORD}}. Done when: Setup is ready.\n`
        );
        if (name !== "unverified") {
          yield* files.writeFileString(
            path.join(root, name, "references/verification.md"),
            "- Verified: 2026-10-02T00:00:00.000Z\n"
          );
        }
      }
      yield* Effect.scoped(
        Effect.gen(function* exerciseContract() {
          const sessions = yield* AgentSession;
          const store = yield* TeachingRecordingStore;
          const teaching = yield* startUserTeaching({
            activity: "teaching",
            clientName: "test",
            clientVersion: "1",
            name: "cart",
            operationId: operation("prereq-teach"),
            url: fixture.url("task-session.html"),
            viewport: agentViewport,
          });
          const { recordingId } = teaching;
          if (recordingId === null) {
            return yield* Effect.die("Missing recording.");
          }
          yield* sessions.startTeachingRecording(
            teaching.id,
            operation("prereq-record")
          );
          yield* sessions.recordInstruction(
            teaching.id,
            "Add an anvil after setup.",
            operation("prereq-instruction")
          );
          yield* sessions.stopTeachingRecording(
            teaching.id,
            operation("prereq-stop")
          );
          yield* teachingRecordingTool("agent_teaching_recording_claim", {
            action: "take",
            operationId: operation("prereq-claim"),
            recordingId,
          });
          yield* teachingRecordingTool("agent_flow_skill_save", {
            claimOperationId: operation("prereq-claim"),
            files: [
              {
                content:
                  "---\nname: cart\ndescription: Add an anvil to the cart.\ninputs:\n  - sku\n  - PASSWORD\n---\n\n1. Add {{sku}} after setup using {{PASSWORD}} if needed. Done when: The cart contains one anvil.\n",
                path: "SKILL.md",
              },
            ],
            operationId: operation("prereq-save"),
            recordingId,
          });
          const start = {
            inputs: [
              {
                changed: true,
                name: "sku",
                secret: false as const,
                value: "anvil",
              },
              { changed: true, name: "PASSWORD", secret: true as const },
            ],
            operationId: operation("prereq-start"),
            prerequisiteInputs: [
              {
                flowSkillName: FlowSkillName.make("location"),
                name: "area",
                value: "North",
              },
              {
                flowSkillName: FlowSkillName.make("login"),
                name: "area",
                value: "South",
              },
            ],
            prerequisites: [
              FlowSkillName.make("location"),
              FlowSkillName.make("login"),
            ],
            recordingId,
            url: fixture.url("task-session.html"),
          };
          for (const [suffix, changes] of [
            ["unknown", { prerequisites: [FlowSkillName.make("unknown")] }],
            [
              "unverified",
              { prerequisites: [FlowSkillName.make("unverified")] },
            ],
            [
              "duplicate",
              {
                prerequisites: [
                  FlowSkillName.make("login"),
                  FlowSkillName.make("login"),
                ],
              },
            ],
            ["target", { prerequisites: [FlowSkillName.make("cart")] }],
            ["missing-input", { prerequisiteInputs: [] }],
            [
              "undeclared",
              {
                prerequisiteInputs: [
                  {
                    flowSkillName: FlowSkillName.make("login"),
                    name: "unknown",
                    value: "x",
                  },
                ],
              },
            ],
            [
              "private-literal",
              {
                prerequisiteInputs: [
                  {
                    flowSkillName: FlowSkillName.make("login"),
                    name: "PASSWORD",
                    value: "never-accept",
                  },
                ],
              },
            ],
          ] as const) {
            const refused = yield* Effect.flip(
              teachingRecordingTool("agent_flow_skill_dry_run_start", {
                ...start,
                ...changes,
                operationId: operation(`prereq-${suffix}`),
              })
            );
            expect(refused.code).toMatch(/invalid|not_found/u);
            expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
              "skill-drafted"
            );
          }
          const started = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            start
          );
          const { session } = started;
          if (session.run === null || !("schemaVersion" in session.run)) {
            return yield* Effect.die("Expected a task Dry Run.");
          }
          expect(
            started.prerequisites.map((skill) => skill.flowSkillName)
          ).toEqual(["location", "login"]);
          expect(session.run.startingEmulation.viewport).toEqual(agentViewport);
          expect(
            (yield* teachingRecordingTool(
              "agent_flow_skill_dry_run_start",
              start
            )).session.id
          ).toBe(session.id);
          expect(
            (yield* Effect.flip(
              teachingRecordingTool("agent_flow_skill_dry_run_start", {
                ...start,
                prerequisiteInputs: start.prerequisiteInputs.filter(
                  (input) => input.flowSkillName === "login"
                ),
                prerequisites: [FlowSkillName.make("login")],
              })
            )).code
          ).toBe("agent_session_conflict");
          expect(
            (yield* Effect.flip(
              runTool("agent_run_update", {
                inputs: [],
                instruction: "Change target",
                operationId: operation("prereq-late"),
                referencedSkills: [],
                sessionId: session.id,
              })
            )).code
          ).toBe("agent_session_invalid");
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: session.id,
          });
          expect(
            observed.nodes.some((node) => node.name === "Signed out")
          ).toBe(true);
          const password = findNode(observed.nodes, "textbox", "Password").ref;
          const entry = {
            flowSkillName: FlowSkillName.make("login"),
            name: "PASSWORD",
            operationId: operation("prereq-unsupplied"),
            ref: password,
            sessionId: session.id,
          };
          expect(
            (yield* Effect.flip(sessionTool("agent_variable_enter", entry)))
              .message
          ).toContain("not been supplied");
          const request = {
            flowSkillName: FlowSkillName.make("login"),
            name: "PASSWORD",
            operationId: operation("prereq-request"),
            sessionId: session.id,
          };
          const requested = yield* sessionTool(
            "agent_variable_request",
            request
          );
          expect(Schema.is(Schema.Json)(requested)).toBe(true);
          const [decision] = requested.pendingDecisions;
          if (decision === undefined) {
            return yield* Effect.die("Missing private request.");
          }
          expect(
            (yield* sessionTool("agent_variable_request", request))
              .pendingDecisions[0]?.pendingDecisionId
          ).toBe(decision.pendingDecisionId);
          const answer = {
            decision: "refuse" as const,
            operationId: operation("prereq-refuse"),
            pendingDecisionId: decision.pendingDecisionId,
          };
          expect(
            (yield* Effect.flip(sessions.resolvePendingDecision(answer)))
              .message
          ).toContain("Workspace");
          yield* sessions.answerDryRunVariable(session.id, answer);
          expect(
            (yield* sessions.answerDryRunVariable(
              session.id,
              answer
            )).decisionHistory.at(-1)?.decision
          ).toBe("refuse");
          const next = yield* sessionTool("agent_variable_request", {
            ...request,
            operationId: operation("prereq-request-again"),
          });
          expect(Schema.is(Schema.Json)(next)).toBe(true);
          const supply = {
            decision: "supply" as const,
            operationId: operation("prereq-supply"),
            pendingDecisionId:
              next.pendingDecisions[0]?.pendingDecisionId ??
              decision.pendingDecisionId,
            value: "private-login-one",
          };
          const supplied = yield* sessions.answerDryRunVariable(
            session.id,
            supply
          );
          expect(
            supplied.run?.variables
              .filter((variable) => variable.supplied)
              .map((variable) =>
                "flowSkillName" in variable ? variable.flowSkillName : ""
              )
          ).toEqual(["login"]);
          expect(JSON.stringify(supplied)).not.toContain(supply.value);
          expect(supplied.run).toMatchObject({
            variables: expect.arrayContaining([
              expect.objectContaining({
                flowSkillName: "login",
                lastAnswer: "supplied",
              }),
            ]),
          });
          yield* sessionTool("agent_variable_enter", {
            ...entry,
            operationId: operation("prereq-enter"),
          });
          const replacing = yield* sessionTool("agent_variable_request", {
            ...request,
            operationId: operation("prereq-replace"),
            replace: true,
          });
          expect(Schema.is(Schema.Json)(replacing)).toBe(true);
          expect(
            replacing.run?.variables.every((variable) => !variable.supplied)
          ).toBe(true);
          expect(
            (yield* Effect.flip(
              sessionTool("agent_variable_enter", {
                ...entry,
                operationId: operation("prereq-enter-old"),
              })
            )).message
          ).toContain("not been supplied");
          const [replacement] = replacing.pendingDecisions;
          if (replacement === undefined) {
            return yield* Effect.die("Missing replacement.");
          }
          yield* sessions.answerDryRunVariable(session.id, {
            ...supply,
            operationId: operation("prereq-supply-new"),
            pendingDecisionId: replacement.pendingDecisionId,
            value: "private-login-two",
          });
          yield* sessions.supplyDryRunVariable(
            session.id,
            "PASSWORD",
            "private-target"
          );
          const afterTargetSupply = yield* sessions.get(session.id);
          expect(
            afterTargetSupply.run?.variables.find(
              (variable) =>
                "flowSkillName" in variable &&
                variable.flowSkillName === "location"
            )?.supplied
          ).toBe(false);
          const otherScope = yield* sessionTool("agent_variable_request", {
            ...request,
            flowSkillName: FlowSkillName.make("location"),
            operationId: operation("prereq-other-request"),
          });
          const [otherDecision] = otherScope.pendingDecisions;
          if (otherDecision === undefined) {
            return yield* Effect.die("Missing independent request.");
          }
          yield* sessions.answerDryRunVariable(session.id, {
            ...supply,
            operationId: operation("prereq-other-supply"),
            pendingDecisionId: otherDecision.pendingDecisionId,
            value: "private-location",
          });
          // Old Dry Run callers may omit the target scope; it must not select login/PASSWORD.
          yield* sessionTool("agent_variable_enter", {
            name: "PASSWORD",
            operationId: operation("prereq-enter-target"),
            ref: password,
            sessionId: session.id,
          });
          const offscope = yield* sessionTool("agent_browser_act", {
            action: {
              type: "navigate",
              url: fixture
                .url("task-session.html")
                .replace("127.0.0.1", "localhost"),
            },
            operationId: operation("prereq-offscope"),
            sessionId: session.id,
          });
          expect(offscope.intervention?.reason).toBe("domain");
          yield* resolveBoundary({
            boundaryId: offscope.intervention?.id ?? "missing",
            decision: "refuse",
            operationId: "prereq-refuse-domain",
            sessionId: session.id,
          });
          const snapshot = yield* sessionTool("agent_browser_snapshot", {
            sessionId: session.id,
          });
          yield* runTool("agent_run_assess", {
            evidence: [{ id: snapshot.snapshotId, kind: "snapshot" }],
            explanation: "Only setup was attempted.",
            operationId: operation("prereq-assess"),
            outcome: "working",
            outcomeComplete: false,
            sessionId: session.id,
          });
          const summary = yield* runTool("agent_run_complete", {
            operationId: operation("prereq-complete"),
            sessionId: session.id,
          });
          expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
            "dry-run-failed"
          );
          expect(JSON.stringify(summary)).not.toMatch(
            /private-login|private-target/u
          );
          const retried = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            { ...start, operationId: operation("prereq-fresh") }
          );
          expect(retried.session.id).not.toBe(session.id);
          expect(
            (yield* Effect.flip(
              sessions.answerDryRunVariable(retried.session.id, supply)
            )).code
          ).toBe("agent_session_conflict");
          expect(
            retried.session.run?.variables.every(
              (variable) => !variable.supplied
            )
          ).toBe(true);
          expect(
            (yield* sessionTool("agent_browser_snapshot", {
              sessionId: retried.session.id,
            })).nodes.some((node) => node.name === "Signed out")
          ).toBe(true);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
