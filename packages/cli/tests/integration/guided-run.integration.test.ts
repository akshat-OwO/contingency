import path from "node:path";

import {
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
  findNode,
  makeCall,
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
        const takeover = yield* Effect.flip(
          sessions.requestTakeover(started.id, "Help", operation("takeover"))
        );
        expect(takeover.code).toBe("agent_control_unavailable");
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
        const hostApproval = yield* Effect.flip(
          sessions.resolvePendingDecision({
            decision: "allow",
            operationId: operation("host-approval"),
            pendingDecisionId: decision.pendingDecisionId,
          })
        );
        expect(hostApproval).toMatchObject({
          code: "agent_session_invalid",
          message: expect.stringContaining("new hosts"),
        });
        // Session closure must drain a partial recording, even without Stop.
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

for (const ending of ["close", "interrupt"] as const) {
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
                session.phase === "closed" || session.phase === "interrupted"
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
          yield* ending === "close"
            ? sessionTool("agent_session_close", {
                operationId: operation("close"),
                sessionId: started.id,
              })
            : sessions.closeAll();
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
            phase: ending === "close" ? "closed" : "interrupted",
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
