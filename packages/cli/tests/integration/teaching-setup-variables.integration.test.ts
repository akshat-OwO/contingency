import path from "node:path";

import { OperationId, compactAgentSession } from "@contingency/protocol";
import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const requestId = (snapshot: AgentSessionSnapshot) => {
  const variable = snapshot.setupVariables?.find((item) => item.name === "OTP");
  if (variable === undefined) {
    throw new Error("Missing Setup Variable");
  }
  return variable.requestId;
};

const request = (
  sessionId: AgentSessionId,
  operation: string,
  replace = false
) =>
  sessionTool("agent_teaching_setup_variable_request", {
    name: "OTP",
    operationId: OperationId.make(operation),
    purpose: "Authenticate before Teaching",
    replace,
    sessionId,
  });

it.live(
  "isolates setup credentials, replays operations, and masks replacements through user recording",
  () =>
    Effect.gen(function* setupVariableLifecycle() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-setup-private-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* preparePrivateSetup() {
          const service = yield* AgentSession;
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "setup-test",
            clientVersion: "1",
            name: "private-setup",
            operationId: OperationId.make("start"),
            url: fixture.url("agent-login.html"),
            viewport: agentViewport,
          });
          const sessionId = started.id;
          const requested = yield* request(sessionId, "request");
          expect(yield* request(sessionId, "request")).toEqual(requested);
          expect(
            yield* sessionTool("agent_teaching_setup_variable_request", {
              name: "OTP",
              operationId: OperationId.make("request"),
              purpose: "Authenticate before Teaching",
              replace: false,
              sessionId,
              view: "full",
            })
          ).toEqual(requested);
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const { ref } = findNode(observed.nodes, "textbox", "Display name");
          const enter = (operation: string) =>
            sessionTool("agent_variable_enter", {
              name: "OTP",
              operationId: OperationId.make(operation),
              ref,
              sessionId,
            });
          expect((yield* Effect.flip(enter("unsupplied"))).code).toBe(
            "agent_session_invalid"
          );
          const answer = {
            operationId: OperationId.make("supply"),
            requestId: requestId(requested),
            sessionId,
            value: "private-first-482915",
          };
          const supplied = yield* service.answerSetupVariable(answer);
          expect(yield* service.answerSetupVariable(answer)).toEqual(supplied);
          expect(
            (yield* Effect.flip(
              service.answerSetupVariable({
                ...answer,
                value: "conflicting-value",
              })
            )).code
          ).toBe("agent_session_conflict");
          const entered = yield* enter("enter");
          expect(entered.entry.outcome).toBe("completed");
          expect(JSON.stringify(entered)).not.toContain(answer.value);
          expect(yield* enter("enter")).toEqual(entered);
          expect((yield* enter("reuse")).entry.outcome).toBe("completed");
          const compact = compactAgentSession(yield* service.get(sessionId));
          expect(compact.setupVariables).toMatchObject([
            { name: "OTP", status: "supplied" },
          ]);

          const replaced = yield* request(sessionId, "replace", true);
          expect(requestId(replaced)).not.toBe(answer.requestId);
          expect(yield* request(sessionId, "replace", true)).toEqual(replaced);
          expect((yield* Effect.flip(enter("awaiting-replacement"))).code).toBe(
            "agent_session_invalid"
          );
          expect(
            (yield* Effect.flip(
              service.answerSetupVariable({
                ...answer,
                operationId: OperationId.make("late-old"),
              })
            )).code
          ).toBe("agent_session_conflict");
          const refusal = {
            operationId: OperationId.make("refuse"),
            requestId: requestId(replaced),
            sessionId,
            value: null,
          };
          const refused = yield* service.answerSetupVariable(refusal);
          expect(yield* service.answerSetupVariable(refusal)).toEqual(refused);
          expect((yield* Effect.flip(enter("refused"))).code).toBe(
            "agent_session_invalid"
          );
          const retried = yield* request(sessionId, "retry");
          const fresh = {
            ...answer,
            operationId: OperationId.make("fresh"),
            requestId: requestId(retried),
            value: "private-second-731904",
          };
          yield* service.answerSetupVariable(fresh);
          const second = yield* enter("enter-fresh");
          expect(JSON.stringify(second)).not.toContain(fresh.value);
          // Replaying replacement must not invalidate the subsequently supplied value.
          yield* request(sessionId, "replace", true);
          expect((yield* enter("reuse-fresh")).entry.outcome).toBe("completed");

          const other = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "setup-test",
            clientVersion: "1",
            name: "other-setup",
            operationId: OperationId.make("other-start"),
            url: fixture.url("agent-login.html"),
            viewport: agentViewport,
          });
          expect(
            (yield* Effect.flip(
              service.answerSetupVariable({
                ...fresh,
                operationId: OperationId.make("cross-session"),
                sessionId: other.id,
              })
            )).code
          ).toBe("agent_session_conflict");
          expect(
            (yield* Effect.flip(
              sessionTool("agent_variable_enter", {
                name: "OTP",
                operationId: OperationId.make("cross-enter"),
                ref,
                sessionId: other.id,
              })
            )).code
          ).toBe("agent_session_invalid");

          const pending = yield* request(sessionId, "pending-handoff", true);
          const handoff = yield* sessionTool("agent_teaching_setup_handoff", {
            operationId: OperationId.make("handoff"),
            sessionId,
          });
          expect(handoff).toMatchObject({
            controller: "user",
            setupVariables: [{ status: "cancelled" }],
            teaching: { actionCount: 0 },
          });
          expect(
            yield* sessionTool("agent_teaching_setup_handoff", {
              operationId: OperationId.make("handoff"),
              sessionId,
            })
          ).toEqual(handoff);
          expect(
            (yield* Effect.flip(
              service.answerSetupVariable({
                ...fresh,
                operationId: OperationId.make("after-handoff"),
                requestId: requestId(pending),
              })
            )).code
          ).toBe("agent_control_unavailable");
          expect((yield* Effect.flip(enter("post-handoff"))).code).toBe(
            "agent_control_unavailable"
          );
          expect(yield* enter("enter")).toEqual(entered);
          const after = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          expect(JSON.stringify(after)).not.toContain(answer.value);
          expect(JSON.stringify(after)).not.toContain(fresh.value);

          yield* service.startTeachingRecording(
            sessionId,
            OperationId.make("record")
          );
          for (const eventType of ["mousePressed", "mouseReleased"] as const) {
            yield* service.sendInput(sessionId, {
              button: "left",
              clickCount: 1,
              eventType,
              type: "input_mouse",
              x: 65,
              y: 220,
            });
          }
          yield* service.stopTeachingRecording(
            sessionId,
            OperationId.make("stop")
          );
          const directory = path.join(
            root,
            ".recordings",
            started.recordingId ?? "missing"
          );
          const events = yield* fs.readFileString(
            path.join(directory, "events.jsonl")
          );
          expect(events).not.toContain(answer.value);
          expect(events).not.toContain(fresh.value);
          expect(events).not.toContain("Authenticate before Teaching");
          expect(events).not.toContain('"kind":"fill"');
          expect(events).not.toContain("{{OTP}}");
          const manifest = yield* fs.readFileString(
            path.join(directory, "manifest.json")
          );
          expect(manifest).not.toContain("setupVariables");
          expect(manifest).not.toContain(answer.value);
          expect(manifest).not.toContain(fresh.value);
          yield* service.close(sessionId, OperationId.make("close"));
          expect((yield* Effect.flip(enter("closed"))).code).toBe(
            "agent_session_conflict"
          );
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("serializes pending supply and entry against setup handoff", () =>
  Effect.gen(function* raceHandoff() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-setup-race-",
    });
    const fixture = yield* fixtureServer;
    yield* Effect.scoped(
      Effect.gen(function* raceSetup() {
        const service = yield* AgentSession;
        const session = yield* sessionTool("agent_session_start", {
          activity: "teaching",
          clientName: "race",
          clientVersion: "1",
          name: "race-setup",
          operationId: OperationId.make("race-start"),
          url: fixture.url("agent-login.html"),
          viewport: agentViewport,
        });
        const requested = yield* request(session.id, "race-request");
        const observed = yield* sessionTool("agent_browser_snapshot", {
          sessionId: session.id,
        });
        const { ref } = findNode(observed.nodes, "textbox", "Display name");
        const outcomes = yield* Effect.all(
          [
            Effect.result(
              service.handOffTeachingSetup(
                session.id,
                OperationId.make("race-handoff")
              )
            ),
            Effect.result(
              service.answerSetupVariable({
                operationId: OperationId.make("race-answer"),
                requestId: requestId(requested),
                sessionId: session.id,
                value: "race-private-550127",
              })
            ),
            Effect.result(
              service.enterSuppliedVariable(
                session.id,
                "OTP",
                ref,
                OperationId.make("race-enter")
              )
            ),
          ],
          { concurrency: "unbounded" }
        );
        expect(outcomes[0]._tag).toBe("Success");
        const current = yield* service.get(session.id);
        expect(current).toMatchObject({
          controller: "user",
          setupVariables: [{ status: "cancelled" }],
        });
        expect(
          (yield* Effect.flip(
            service.enterSuppliedVariable(
              session.id,
              "OTP",
              ref,
              OperationId.make("late-race-enter")
            )
          )).code
        ).toBe("agent_control_unavailable");
        expect(
          (yield* Effect.flip(request(session.id, "late-request"))).code
        ).toBe("agent_control_unavailable");
        const ready = yield* sessionTool("agent_session_start", {
          activity: "teaching",
          clientName: "race",
          clientVersion: "1",
          name: "supplied-race",
          operationId: OperationId.make("supplied-race-start"),
          url: fixture.url("agent-login.html"),
          viewport: agentViewport,
        });
        const awaiting = yield* request(ready.id, "supplied-race-request");
        yield* service.answerSetupVariable({
          operationId: OperationId.make("supplied-race-answer"),
          requestId: requestId(awaiting),
          sessionId: ready.id,
          value: "concurrent-private-550127",
        });
        const page = yield* sessionTool("agent_browser_snapshot", {
          sessionId: ready.id,
        });
        const [entry, handedOff] = yield* Effect.all(
          [
            service.enterSuppliedVariable(
              ready.id,
              "OTP",
              findNode(page.nodes, "textbox", "Display name").ref,
              OperationId.make("supplied-race-enter")
            ),
            service.handOffTeachingSetup(
              ready.id,
              OperationId.make("supplied-race-handoff")
            ),
          ],
          { concurrency: "unbounded" }
        );
        expect(entry.entry.outcome).toBe("completed");
        expect(handedOff).toMatchObject({
          controller: "user",
          setupVariables: [{ status: "cancelled" }],
        });
        expect(JSON.stringify(entry)).not.toContain(
          "concurrent-private-550127"
        );
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
