import path from "node:path";
import { buffer } from "node:stream/consumers";

import {
  ContingencyRpcs,
  FlowSkillName,
  OperationId,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Schema,
  Stream,
} from "effect";
import type { PlatformError } from "effect";
import { RpcTest } from "effect/rpc";
import { yauzl } from "playwright-core/lib/utilsBundle";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeChromiumAgentBrowser } from "../../src/services/chromium-agent-browser.ts";
import {
  PursuitToolHandlersLive,
  PursuitTools,
} from "../../src/services/mcp-pursuit.ts";
import { SystemOne } from "../../src/services/system-one.ts";
import {
  agentProcessLayer,
  agentViewport,
  catalogTool,
  findNode,
  makeCall,
  requireBoundaryDecision,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const operation = OperationId.make;
const pursue = makeCall(PursuitTools);

it.live(
  "Guided Runs keep setup out, record agent actions, refuse unsupported authority, and learn partial journeys",
  () =>
    Effect.gen(function* guidedRun() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "guided-run-" });
      const fixtures = yield* fixtureServer;
      yield* Effect.gen(function* recordAndLearn() {
        const sessions = yield* AgentSession;
        const params = {
          name: FlowSkillName.make("guided-delivery"),
          operationId: operation("guided-start"),
          url: fixtures.url("delivery.html"),
          viewport: agentViewport,
        };
        const android = yield* Effect.flip(
          sessionTool("agent_guided_run_start", {
            ...params,
            platform: "android",
          })
        );
        expect(android).toMatchObject({
          code: "agent_session_invalid",
          message: expect.stringContaining("android"),
        });
        const started = yield* sessionTool("agent_guided_run_start", params);
        expect(started).toMatchObject({
          activity: "teaching",
          captureState: { _tag: "setup" },
          controller: "agent",
          origin: "guided-run",
        });
        expect((yield* sessionTool("agent_guided_run_start", params)).id).toBe(
          started.id
        );
        if (started.recordingId === null) {
          return yield* Effect.die("No recording");
        }
        const directory = path.join(root, ".recordings", started.recordingId);
        const first = yield* sessionTool("agent_browser_snapshot", {
          sessionId: started.id,
        });
        const prepared = yield* sessionTool("agent_browser_act", {
          action: {
            ref: findNode(first.nodes, "button", "Choose delivery area").ref,
            type: "click",
          },
          operationId: operation("setup-choose"),
          sessionId: started.id,
        });
        expect(yield* fs.readDirectory(directory)).toEqual(["manifest.json"]);
        const modification = yield* Effect.flip(
          sessions.devtools(started.id, {
            action: "storage_set",
            key: "probe",
            kind: "local",
            operationId: "mod",
            value: "changed",
          })
        );
        expect(modification.message).toContain("Guided Run");
        const emulation = yield* Effect.flip(
          sessions.devtools(started.id, {
            action: "emulation_set",
            operationId: "emulation-mod",
            pageZoom: 125,
          })
        );
        expect(emulation.message).toContain("Guided Run");
        expect(
          yield* sessions.devtools(started.id, { action: "emulation_get" })
        ).toMatchObject({ pageZoom: 100 });
        expect(
          yield* sessions.devtools(started.id, { action: "modifications_list" })
        ).toMatchObject({ modifications: [] });
        const pursuit = yield* Effect.flip(
          pursue("agent_browser_pursue", {
            operationId: operation("pursue"),
            sessionId: started.id,
            steps: [{ doneWhen: "Delivery is set", goal: "Choose delivery" }],
          })
        );
        expect(pursuit).toMatchObject({
          code: "agent_session_invalid",
          message: expect.stringContaining("Guided Run"),
        });
        yield* sessionTool("agent_teaching_setup_handoff", {
          operationId: operation("handoff"),
          sessionId: started.id,
        });
        const waiting = yield* Effect.flip(
          sessionTool("agent_browser_act", {
            action: { action: "reload", type: "history" },
            operationId: operation("too-early"),
            sessionId: started.id,
          })
        );
        expect(waiting.code).toBe("agent_control_unavailable");
        const recording = yield* sessions.startTeachingRecording(
          started.id,
          operation("user-start")
        );
        expect(recording).toMatchObject({
          captureState: { _tag: "recording" },
          controller: "agent",
          origin: "guided-run",
        });
        const asked = yield* catalogTool("agent_guided_run_question_ask", {
          operationId: operation("question"),
          sessionId: started.id,
          text: "Which delivery option?",
        });
        const question = asked.teaching?.instructions.at(-1);
        expect(question).toMatchObject({
          actor: "agent",
          dialogue: { _tag: "question" },
          text: "Which delivery option?",
        });
        if (question === undefined) {
          return yield* Effect.die("No question");
        }
        expect(
          (yield* catalogTool("agent_guided_run_question_ask", {
            operationId: operation("question"),
            sessionId: started.id,
            text: "Which delivery option?",
          })).teaching?.instructions
        ).toHaveLength(1);
        const cursor = (yield* sessions.sessionEvents(started.id)).eventCursor;
        const waiter = yield* sessions
          .waitForEvents(started.id, cursor)
          .pipe(Effect.forkScoped);
        const answered = yield* sessions.recordInstruction(
          started.id,
          "Use manual delivery",
          operation("answer"),
          undefined,
          undefined,
          undefined,
          undefined,
          question.id
        );
        expect(answered.teaching?.instructions.at(-1)).toMatchObject({
          actor: "user",
          dialogue: { _tag: "answer", questionId: question.id },
        });
        expect((yield* Fiber.join(waiter)).events).toMatchObject([
          { kind: "question-answered", name: question.id },
        ]);
        expect(
          yield* sessions.recordInstruction(
            started.id,
            "Use manual delivery",
            operation("answer"),
            undefined,
            undefined,
            undefined,
            undefined,
            question.id
          )
        ).toEqual(answered);
        const duplicate = yield* Effect.flip(
          catalogTool("agent_teaching_instruction_record", {
            operationId: operation("second-answer"),
            questionId: question.id,
            sessionId: started.id,
            text: "Use automatic delivery",
          })
        );
        expect(duplicate.code).toBe("agent_session_conflict");
        const clicked = yield* sessionTool("agent_browser_act", {
          action: {
            ref: findNode(prepared.snapshot.nodes, "button", "Select manually")
              .ref,
            type: "click",
          },
          operationId: operation("record-manual"),
          sessionId: started.id,
        });
        expect(clicked.entry.outcome).toBe("completed");
        const relayQuestion = (yield* catalogTool(
          "agent_guided_run_question_ask",
          {
            operationId: operation("relay-question"),
            sessionId: started.id,
            text: "Which city?",
          }
        )).teaching?.instructions.at(-1);
        if (relayQuestion === undefined) {
          return yield* Effect.die("No relay question");
        }
        const relayed = yield* catalogTool(
          "agent_teaching_instruction_record",
          {
            operationId: operation("relay-answer"),
            questionId: relayQuestion.id,
            sessionId: started.id,
            text: "Pune",
          }
        );
        expect(relayed.teaching?.instructions.at(-1)).toMatchObject({
          actor: "agent",
          dialogue: { _tag: "answer", questionId: relayQuestion.id },
          text: "Pune",
        });
        const lateUserAnswer = yield* Effect.flip(
          sessions.recordInstruction(
            started.id,
            "Delhi",
            operation("late-user"),
            undefined,
            undefined,
            undefined,
            undefined,
            relayQuestion.id
          )
        );
        expect(lateUserAnswer.code).toBe("agent_session_conflict");
        const unanswered = (yield* catalogTool(
          "agent_guided_run_question_ask",
          {
            operationId: operation("unanswered"),
            sessionId: started.id,
            text: "Anything else?",
          }
        )).teaching?.instructions.at(-1);
        const immutable = yield* Effect.flip(
          sessions.recordInstruction(
            started.id,
            "Changed question",
            operation("replace-question"),
            undefined,
            undefined,
            undefined,
            question.id
          )
        );
        expect(immutable.code).toBe("agent_session_invalid");

        const takeover = yield* sessions.requestTakeover(
          started.id,
          "Help",
          operation("takeover")
        );
        expect(takeover.phase).toBe("takeover");
        yield* sessions.takeover(started.id, "Demonstrate", operation("take"));
        yield* sessions.returnControl(started.id, operation("return"));
        const outside = yield* sessionTool("agent_browser_act", {
          action: {
            type: "navigate",
            url: params.url.replace("127.0.0.1", "localhost"),
          },
          operationId: operation("outside"),
          sessionId: started.id,
        });
        expect(outside).toMatchObject({
          entry: { dispatched: false },
          intervention: { reason: "domain" },
        });
        const paused = yield* sessions.get(started.id);
        expect(paused.currentUrl).toBe(clicked.url);
        const decision = paused.pendingDecisions.find(
          (item) => item.kind === "boundary"
        );
        if (decision === undefined) {
          return yield* Effect.die("No domain decision");
        }
        yield* sessions.resolvePendingDecision({
          decision: "allow",
          operationId: operation("host-approval"),
          pendingDecisionId: decision.pendingDecisionId,
        });
        // Closing before resume retains an approved but unvisited host.
        const closed = yield* sessionTool("agent_session_close", {
          operationId: operation("close"),
          sessionId: started.id,
        });
        expect(closed).toMatchObject({
          captureState: { _tag: "ready" },
          origin: "guided-run",
          phase: "closed",
        });
        const manifest = yield* Schema.decodeUnknownEffect(
          TeachingRecordingManifest
        )(
          JSON.parse(
            yield* fs.readFileString(path.join(directory, "manifest.json"))
          )
        );
        expect(manifest.origin).toBe("guided-run");
        expect(manifest.approvedHosts).toEqual(["127.0.0.1", "localhost"]);
        const claimOperationId = operation("claim");
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId: started.recordingId,
        });
        const timeline = yield* teachingRecordingTool(
          "agent_teaching_timeline_get",
          { claimOperationId, recordingId: started.recordingId }
        );
        expect(
          timeline.entries.filter((event) => event._tag === "action")
        ).toMatchObject([
          {
            actor: "agent",
            description: 'Click button "Select manually"',
            outcome: "succeeded",
            target: { name: "Select manually", role: "button" },
          },
        ]);
        expect(
          timeline.entries.filter((event) => event._tag === "action")
        ).toHaveLength(1);
        expect(
          timeline.entries.filter(
            (event) => event._tag === "instruction" || event._tag === "action"
          )
        ).toMatchObject([
          {
            _tag: "instruction",
            actor: "agent",
            dialogue: { _tag: "question" },
            id: question.id,
            text: "Which delivery option?",
          },
          {
            _tag: "instruction",
            actor: "user",
            dialogue: { _tag: "answer", questionId: question.id },
            text: "Use manual delivery",
          },
          { _tag: "action", actor: "agent" },
          {
            _tag: "instruction",
            actor: "agent",
            dialogue: { _tag: "question" },
            id: relayQuestion.id,
          },
          {
            _tag: "instruction",
            actor: "agent",
            dialogue: { _tag: "answer", questionId: relayQuestion.id },
            text: "Pune",
          },
          {
            _tag: "instruction",
            dialogue: { _tag: "question" },
            id: unanswered?.id,
            text: "Anything else?",
          },
        ]);

        expect(timeline.entries.at(-1)).toMatchObject({
          _tag: "stopped",
          reason: "session-closed",
        });
        expect(
          yield* fs.readFileString(path.join(directory, "events.jsonl"))
        ).not.toContain("Choose delivery area");
      }).pipe(
        Effect.provide(PursuitToolHandlersLive),
        Effect.provide(
          Layer.succeed(SystemOne, {
            ask: () =>
              Effect.die("A refused Pursuit must never call System One"),
            first: false,
          })
        ),
        Effect.provide(agentProcessLayer(root))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const ending of ["close", "interrupt", "takeover"] as const) {
  it.live(
    `Guided Run ${ending} records a dispatched action before finalizing`,
    () =>
      Effect.gen(function* closeDuringAction() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "guided-close-",
        });
        const fixtures = yield* fixtureServer;
        const performed = yield* Deferred.make<true>();
        const release = yield* Deferred.make<true>();
        yield* Effect.gen(function* recordInterruptedAttempt() {
          const sessions = yield* AgentSession;
          const started = yield* sessionTool("agent_guided_run_start", {
            name: FlowSkillName.make("guided-close"),
            operationId: operation("start"),
            url: fixtures.url("delivery.html"),
            viewport: agentViewport,
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Expected a recording");
          }
          yield* sessionTool("agent_teaching_setup_handoff", {
            operationId: operation("handoff"),
            sessionId: started.id,
          });
          yield* sessions.startTeachingRecording(
            started.id,
            operation("record")
          );
          const snapshot = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          // On the unfixed code, release only after closure has frozen the
          // capture. This keeps the reproduction finite without a timed wait.
          yield* sessions.changes(started.id).pipe(
            Stream.filter(
              (session) =>
                session.phase === "closed" ||
                session.phase === "interrupted" ||
                session.phase === "takeover"
            ),
            Stream.take(1),
            Stream.runForEach(() => Deferred.succeed(release, true)),
            Effect.forkScoped
          );
          const action = yield* sessionTool("agent_browser_act", {
            action: {
              ref: findNode(snapshot.nodes, "button", "Choose delivery area")
                .ref,
              type: "click",
            },
            operationId: operation("held-action"),
            sessionId: started.id,
          }).pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(performed).pipe(Effect.timeout("30 seconds"));
          // The real click happened, but its acknowledgement is held until closure.
          // Close must settle it without waiting for a timer or a test release.
          if (ending === "close") {
            yield* sessionTool("agent_session_close", {
              operationId: operation("close"),
              sessionId: started.id,
            });
          } else if (ending === "interrupt") {
            yield* sessions.closeAll();
          } else {
            yield* sessions.takeover(started.id, "Help", operation("take"));
          }
          if (ending === "takeover") {
            expect(
              (yield* sessions.get(started.id)).interruptedAction
            ).toMatchObject({ dispatched: true, outcome: "interrupted" });
            yield* sessions.returnControl(started.id, operation("return"));
            yield* sessionTool("agent_session_close", {
              operationId: operation("close"),
              sessionId: started.id,
            });
          }
          const claimOperationId = operation("claim");
          yield* teachingRecordingTool("agent_teaching_recording_claim", {
            action: "take",
            operationId: claimOperationId,
            recordingId: started.recordingId,
          });
          const timeline = yield* teachingRecordingTool(
            "agent_teaching_timeline_get",
            {
              claimOperationId,
              recordingId: started.recordingId,
            }
          );
          expect(
            timeline.entries.filter((event) => event._tag === "action")
          ).toMatchObject([
            {
              actor: "agent",
              detail: expect.stringContaining("interrupted"),
              outcome: "failed",
              target: { name: "Choose delivery area", role: "button" },
            },
          ]);
          expect(timeline.entries.at(-1)).toMatchObject({
            _tag: "stopped",
            reason: "session-closed",
          });
          const events = yield* fs.readFileString(
            path.join(root, ".recordings", started.recordingId, "events.jsonl")
          );
          expect(events).toContain('"outcome":"failed"');
          expect(yield* sessions.get(started.id)).toMatchObject({
            captureState: { _tag: "learning" },
            phase: ending === "interrupt" ? "interrupted" : "closed",
            timeline: expect.arrayContaining([
              expect.objectContaining({
                dispatched: true,
                outcome: "interrupted",
              }),
            ]),
          });
          yield* Fiber.join(action);
          expect(events).toContain("Choose delivery area");
          const refused = yield* Effect.flip(
            sessionTool("agent_browser_act", {
              action: { action: "reload", type: "history" },
              operationId: operation("after-close"),
              sessionId: started.id,
            })
          );
          expect(refused.code).toBe("agent_session_conflict");
        }).pipe(
          Effect.onExit(() => Deferred.succeed(release, true)),
          Effect.provide(
            agentProcessLayer(root, {
              agentBrowserFactory: (input) =>
                makeChromiumAgentBrowser(input).pipe(
                  Effect.map((browser) => ({
                    ...browser,
                    active: () =>
                      browser.active().pipe(
                        Effect.map((tab) => ({
                          ...tab,
                          perform: (action, pointer) =>
                            tab
                              .perform(action, pointer)
                              .pipe(
                                Effect.andThen(
                                  Deferred.succeed(performed, true)
                                ),
                                Effect.andThen(Deferred.await(release))
                              ),
                        }))
                      ),
                  }))
                ),
            })
          )
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.timeout("60 seconds")
      )
  );
}

it.live(
  "Guided Run Takeover captures user actions and only Variable references",
  () =>
    Effect.gen(function* guidedTakeover() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "guided-takeover-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.gen(function* demonstrate() {
        const sessions = yield* AgentSession;
        const started = yield* sessionTool("agent_guided_run_start", {
          name: FlowSkillName.make("guided-email"),
          operationId: operation("start"),
          url: fixtures.url("agent-login.html"),
          viewport: agentViewport,
        });
        expect(
          (yield* Effect.flip(sessions.takeover(started.id, "Early"))).code
        ).toBe("agent_control_unavailable");
        yield* sessions.handOffTeachingSetup(started.id, operation("handoff"));
        yield* sessions.startTeachingRecording(started.id, operation("record"));
        yield* sessionTool("agent_browser_act", {
          action: { action: "reload", type: "history" },
          operationId: operation("before"),
          sessionId: started.id,
        });
        const asked = yield* sessions.askQuestion(
          started.id,
          "Which email?",
          operation("ask")
        );
        const question = asked.teaching?.instructions.at(-1);
        yield* sessions.requestTakeover(
          started.id,
          "Show the email",
          operation("request")
        );
        expect((yield* sessions.get(started.id)).controller).toBe("agent");
        expect(
          (yield* Effect.flip(
            sessionTool("agent_browser_act", {
              action: { action: "reload", type: "history" },
              operationId: operation("request-blocked"),
              sessionId: started.id,
            })
          )).code
        ).toBe("agent_control_unavailable");
        yield* sessions.takeover(
          started.id,
          "Show the email",
          operation("take")
        );
        expect(
          (yield* Effect.flip(
            sessionTool("agent_browser_act", {
              action: { action: "reload", type: "history" },
              operationId: operation("blocked"),
              sessionId: started.id,
            })
          )).code
        ).toBe("agent_control_unavailable");
        for (const eventType of ["mousePressed", "mouseReleased"] as const) {
          yield* sessions.sendInput(started.id, {
            button: "left",
            clickCount: 1,
            eventType,
            type: "input_mouse",
            x: 240,
            y: 150,
          });
        }
        for (const text of "public") {
          yield* sessions.sendInput(started.id, {
            eventType: "keyDown",
            key: text,
            text,
            type: "input_keyboard",
          });
          yield* sessions.sendInput(started.id, {
            eventType: "keyUp",
            key: text,
            type: "input_keyboard",
          });
        }
        const secret = "takeover-private-530@example.org";
        yield* sessions.enterUserVariable(
          started.id,
          {
            ref: findNode(
              (yield* sessions.snapshot(started.id)).nodes,
              "textbox",
              "Password"
            ).ref,
            value: secret,
            variable: { name: "EMAIL", runtime: true, secret: true },
          },
          operation("private")
        );
        const returned = yield* sessions.returnControl(
          started.id,
          operation("return")
        );
        expect(returned).toMatchObject({
          controller: "agent",
          phase: "running",
          takeover: null,
        });
        expect(returned.teaching?.instructions).toEqual([question]);
        yield* sessionTool("agent_browser_act", {
          action: { action: "reload", type: "history" },
          operationId: operation("after"),
          sessionId: started.id,
        });
        yield* sessions.stopTeachingRecording(started.id, operation("stop"));
        const { recordingId } = started;
        if (recordingId === null) {
          return yield* Effect.die("No recording");
        }
        const claimOperationId = operation("claim");
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId,
        });
        const timeline = yield* teachingRecordingTool(
          "agent_teaching_timeline_get",
          { claimOperationId, recordingId }
        );
        expect(
          timeline.entries.filter((e) => e._tag === "action")
        ).toMatchObject([
          { actor: "agent" },
          { actor: "user" },
          { actor: "user" },
          {
            actor: "user",
            description: 'Enter Variable EMAIL in textbox "Password"',
            kind: "fill",
          },
          { actor: "agent" },
        ]);
        const directory = path.join(root, ".recordings", recordingId);
        const inspect = (
          dir: string
        ): Effect.Effect<void, PlatformError.PlatformError> =>
          Effect.gen(function* inspectFiles() {
            for (const name of yield* fs.readDirectory(dir)) {
              const file = path.join(dir, name);
              if ((yield* fs.stat(file)).type === "Directory") {
                yield* inspect(file);
              } else {
                expect(
                  Buffer.from(yield* fs.readFile(file)).includes(
                    Buffer.from(secret)
                  )
                ).toBe(false);
              }
            }
          });
        yield* inspect(directory);
        yield* Effect.promise(async () => {
          const archive = await yauzl.openPromise(
            path.join(directory, "trace.zip"),
            { lazyEntries: true }
          );
          for await (const entry of archive.eachEntry()) {
            const contents = await buffer(
              await archive.openReadStreamPromise(entry)
            );
            expect(contents.includes(Buffer.from(secret)), entry.fileName).toBe(
              false
            );
          }
        });
        expect(JSON.stringify(timeline)).not.toContain(secret);
        expect(JSON.stringify(timeline)).toContain("{{EMAIL}}");
        yield* teachingRecordingTool("agent_flow_skill_save", {
          claimOperationId,
          files: [
            {
              content: `---
name: guided-email
description: Enter a private password on the sign in page.
inputs:
  - EMAIL
---

# Enter the password

1. Enter {{EMAIL}} in Password. Done when: Password is filled.
`,
              path: "SKILL.md",
            },
          ],
          operationId: operation("save"),
          recordingId,
        });
        const dry = yield* teachingRecordingTool(
          "agent_flow_skill_dry_run_start",
          {
            inputs: [{ changed: true, name: "EMAIL", secret: true }],
            operationId: operation("dry-start"),
            recordingId,
            url: fixtures.url("agent-login.html"),
          }
        );
        expect(dry.session.id).not.toBe(started.id);
        yield* sessions.supplyDryRunVariable(
          dry.session.id,
          "EMAIL",
          "fresh-private@example.org"
        );
        const observed = yield* sessions.snapshot(dry.session.id);
        yield* sessions.enterSuppliedVariable(
          dry.session.id,
          "EMAIL",
          findNode(observed.nodes, "textbox", "Password").ref,
          operation("dry-enter")
        );
        const evidence = yield* sessions.snapshot(dry.session.id);
        yield* sessions.assessTask(
          dry.session.id,
          {
            evidence: [{ id: evidence.snapshotId, kind: "snapshot" }],
            explanation: "The private password field is filled.",
            outcome: "working",
            outcomeComplete: true,
          },
          false,
          operation("dry-assess")
        );
        const completed = yield* sessions.completeRun(dry.session.id);
        if (completed.schemaVersion !== 3) {
          return yield* Effect.die("Expected a task Dry Run Summary");
        }
        expect(completed.purpose).toMatchObject({
          takeoverOccurred: false,
        });
        const manifest = JSON.parse(
          yield* fs.readFileString(path.join(directory, "manifest.json"))
        );
        expect(manifest.lifecycle._tag).toBe("dry-run-passed");
      }).pipe(Effect.provide(agentProcessLayer(root)));
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.timeout("60 seconds")
    )
);

it.live(
  "Guided Run approved scope survives learning and bounds its Dry Run",
  () =>
    Effect.gen(function* approvedScope() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "guided-hosts-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.gen(function* approveAndLearn() {
        const sessions = yield* AgentSession;
        const client = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        const url = fixtures.url("agent-boundary-frame.html");
        const second = url.replace("127.0.0.1", "localhost");
        const third = "http://unapproved.example/";
        const started = yield* sessionTool("agent_guided_run_start", {
          name: FlowSkillName.make("guided-hosts"),
          operationId: operation("start"),
          url,
          viewport: agentViewport,
        });
        const sessionId = started.id;
        const { recordingId } = started;
        if (recordingId === null) {
          return yield* Effect.die("Missing recording");
        }
        yield* sessionTool("agent_teaching_setup_handoff", {
          operationId: operation("handoff"),
          sessionId,
        });
        yield* sessions.startTeachingRecording(sessionId, operation("record"));
        yield* sessionTool("agent_browser_snapshot", { sessionId });
        // The fixture embeds a third-party frame, which does not grow the scope.
        expect(fixtures.requests).toContain("/outside-frame.html");
        expect((yield* sessions.get(sessionId)).boundary).toBeNull();
        const paused = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: second },
          intent: { irreversible: true },
          operationId: operation("second"),
          sessionId,
        });
        expect(paused.entry.dispatched).toBe(false);
        const boundaryId = paused.intervention?.id ?? "missing";
        const pending = requireBoundaryDecision(
          yield* sessions.get(sessionId),
          boundaryId
        );
        expect(pending.scopeSummary).toContain("localhost");
        expect(pending.scopeSummary).toContain("Flow Skill");
        expect((yield* sessions.get(sessionId)).currentUrl).toBe(url);
        const approval = {
          decision: "allow" as const,
          operationId: operation("approve"),
          pendingDecisionId: pending.pendingDecisionId,
          sessionId,
        };
        yield* client("agent.boundary.decision", approval);
        yield* client("agent.boundary.decision", approval);
        const confirmation = yield* sessionTool("agent_browser_resume", {
          boundaryId,
          sessionId,
        });
        expect(confirmation.entry.dispatched).toBe(false);
        expect(confirmation.intervention?.reason).toBe("confirmation");
        const confirmationId = confirmation.intervention?.id ?? "missing";
        const confirm = requireBoundaryDecision(
          yield* sessions.get(sessionId),
          confirmationId
        );
        yield* sessions.resolvePendingDecision({
          decision: "allow",
          operationId: operation("confirm"),
          pendingDecisionId: confirm.pendingDecisionId,
        });
        const resumed = yield* sessionTool("agent_browser_resume", {
          boundaryId: confirmationId,
          sessionId,
        });
        expect(resumed.entry.outcome).toBe("completed");
        expect(resumed.url).toBe(second);
        expect(
          (yield* sessionTool("agent_browser_resume", {
            boundaryId: confirmationId,
            sessionId,
          })).entry.id
        ).toBe(resumed.entry.id);
        for (const [index, destination] of [url, second].entries()) {
          const visit = yield* sessionTool("agent_browser_act", {
            action: { type: "navigate", url: destination },
            operationId: operation(`revisit-${index}`),
            sessionId,
          });
          expect(visit.entry.outcome).toBe("completed");
          expect(visit.intervention).toBeUndefined();
        }
        const denied = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: third },
          operationId: operation("third"),
          sessionId,
        });
        const deniedId = denied.intervention?.id ?? "missing";
        const deny = requireBoundaryDecision(
          yield* sessions.get(sessionId),
          deniedId
        );
        yield* sessions.resolvePendingDecision({
          decision: "refuse",
          operationId: operation("refuse"),
          pendingDecisionId: deny.pendingDecisionId,
        });
        const refusal = yield* Effect.flip(
          sessionTool("agent_browser_resume", {
            boundaryId: deniedId,
            sessionId,
          })
        );
        expect(refusal.code).toBe("agent_session_conflict");
        expect(refusal.message).toContain("refused");
        expect((yield* sessions.get(sessionId)).currentUrl).toBe(second);
        yield* sessions.stopTeachingRecording(sessionId, operation("stop"));
        const manifest = Schema.decodeUnknownSync(TeachingRecordingManifest)(
          JSON.parse(
            yield* fs.readFileString(
              path.join(root, ".recordings", recordingId, "manifest.json")
            )
          )
        );
        expect(manifest).toHaveProperty("approvedHosts", [
          "127.0.0.1",
          "localhost",
        ]);
        const claimOperationId = operation("claim");
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId,
        });
        yield* teachingRecordingTool("agent_flow_skill_save", {
          claimOperationId,
          files: [
            {
              content: `---
name: guided-hosts
description: Inspect the fixture across its approved hosts.
inputs:
---

# Inspect the fixture

1. Open the fixture on localhost. Done when: the fixture page appears.
`,
              path: "SKILL.md",
            },
          ],
          operationId: operation("save"),
          recordingId,
        });
        const saved = yield* fs.readFileString(
          path.join(root, "guided-hosts", "SKILL.md")
        );
        expect(saved).toContain("hosts:\n  - 127.0.0.1\n  - localhost");
        expect(saved).not.toContain("unapproved.example");
        const dry = yield* teachingRecordingTool(
          "agent_flow_skill_dry_run_start",
          { inputs: [], operationId: operation("dry"), recordingId, url }
        );
        const drySecond = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: second },
          operationId: operation("dry-second"),
          sessionId: dry.session.id,
        });
        expect(drySecond.intervention).toBeUndefined();
        const dryThird = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: third },
          operationId: operation("dry-third"),
          sessionId: dry.session.id,
        });
        expect(dryThird.intervention?.reason).toBe("domain");
        expect(dryThird.entry.dispatched).toBe(false);
      }).pipe(Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
