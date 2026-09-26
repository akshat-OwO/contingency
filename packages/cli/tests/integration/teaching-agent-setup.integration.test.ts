import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** The prerequisite the agent prepares before the user demonstrates. */
const PREPARED_CITY = "Gurugram";
const PREPARED_AREA = "Sector 14";

/** Where the user's pointer lands on the confirmation button. */
const CONFIRM_AREA = { x: 120, y: 256 } as const;

const clickAsUser = (
  sessionId: AgentSessionId,
  at: { readonly x: number; readonly y: number }
) =>
  Effect.gen(function* clickAsTheUser() {
    const service = yield* AgentSession;
    for (const eventType of ["mousePressed", "mouseReleased"] as const) {
      yield* service.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        x: at.x,
        y: at.y,
      });
    }
  });

/** The agent chooses a delivery area through the ordinary browser tools. */
const prepareDeliveryAsAgent = (sessionId: AgentSessionId) =>
  Effect.gen(function* prepareDeliveryArea() {
    const first = yield* sessionTool("agent_browser_snapshot", { sessionId });
    const choosing = yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(first.nodes, "button", "Choose delivery area").ref,
        type: "click",
      },
      operationId: OperationId.make("setup-choose"),
      sessionId,
    });
    const picking = yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(choosing.snapshot.nodes, "button", "Select manually").ref,
        type: "click",
      },
      operationId: OperationId.make("setup-manual"),
      sessionId,
    });
    const cityFilled = yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(picking.snapshot.nodes, "textbox", "City").ref,
        text: PREPARED_CITY,
        type: "fill",
      },
      operationId: OperationId.make("setup-city"),
      sessionId,
    });
    const areaFilled = yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(
          cityFilled.snapshot.nodes,
          "textbox",
          "Search for your delivery area"
        ).ref,
        text: PREPARED_AREA,
        type: "fill",
      },
      operationId: OperationId.make("setup-area"),
      sessionId,
    });
    return areaFilled.snapshot;
  });

it.live(
  "lets an agent prepare Teaching setup and records only the user after handoff",
  () =>
    Effect.gen(function* agentPreparesThenUserRecords() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-agent-setup-",
      });
      const fixtures = yield* fixtureServer;

      const recordingId = yield* Effect.scoped(
        Effect.gen(function* prepareAndRecord() {
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "integration-agent",
            clientVersion: "1.0.0",
            name: "confirm-delivery-area",
            operationId: OperationId.make("agent-setup-start"),
            url: fixtures.url("delivery.html"),
            viewport: agentViewport,
          });
          expect(started).toMatchObject({
            captureState: { _tag: "setup" },
            controller: "agent",
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          const recordingDirectory = path.join(
            root,
            ".recordings",
            started.recordingId
          );
          const service = yield* AgentSession;

          const prepared = yield* prepareDeliveryAsAgent(started.id);
          findNode(prepared.nodes, "button", "Confirm delivery area");

          // The agent holds the browser: the user cannot drive it or start
          // recording, even by calling the session directly.
          const refusedInput = yield* Effect.flip(
            clickAsUser(started.id, CONFIRM_AREA)
          );
          expect(refusedInput.code).toBe("agent_control_unavailable");
          const refusedStart = yield* Effect.flip(
            service.startTeachingRecording(
              started.id,
              OperationId.make("agent-setup-early-start")
            )
          );
          expect(refusedStart.code).toBe("agent_control_unavailable");

          const handedOff = yield* sessionTool("agent_teaching_setup_handoff", {
            operationId: OperationId.make("agent-setup-handoff"),
            sessionId: started.id,
          });
          expect(handedOff).toMatchObject({
            captureState: { _tag: "setup" },
            controller: "user",
          });
          // Setup stays outside capture: nothing but the manifest exists yet.
          expect(yield* fileSystem.readDirectory(recordingDirectory)).toEqual([
            "manifest.json",
          ]);

          const retried = yield* sessionTool("agent_teaching_setup_handoff", {
            operationId: OperationId.make("agent-setup-handoff-retry"),
            sessionId: started.id,
          });
          expect(retried.controller).toBe("user");
          const refusedAction = yield* Effect.flip(
            sessionTool("agent_browser_act", {
              action: { action: "reload", type: "history" },
              operationId: OperationId.make("agent-setup-after-handoff"),
              sessionId: started.id,
            })
          );
          expect(refusedAction.code).toBe("agent_control_unavailable");

          yield* service.startTeachingRecording(
            started.id,
            OperationId.make("agent-setup-start-recording")
          );
          yield* clickAsUser(started.id, CONFIRM_AREA);
          const confirmed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          expect(
            confirmed.nodes.some((node) =>
              node.name.includes(
                `Delivering to ${PREPARED_AREA}, ${PREPARED_CITY}`
              )
            )
          ).toBe(true);
          yield* service.stopTeachingRecording(
            started.id,
            OperationId.make("agent-setup-stop-recording")
          );
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      yield* Effect.scoped(
        Effect.gen(function* readRecordingInLaterProcess() {
          const claimOperationId = OperationId.make("agent-setup-claim");
          yield* teachingRecordingTool("agent_teaching_recording_claim", {
            action: "take",
            operationId: claimOperationId,
            recordingId,
          });
          const timeline = yield* teachingRecordingTool(
            "agent_teaching_timeline_get",
            { claimOperationId, recordingId }
          );
          const actions = timeline.entries.filter(
            (entry) => entry._tag === "action"
          );
          // Only the user's click after Start is a demonstrated step. The
          // agent's setup clicks and fills are in no recorded event.
          expect(
            actions.map((entry) =>
              entry._tag === "action" ? entry.description : ""
            )
          ).toEqual(['Click button "Confirm delivery area"']);
          const actionIds = new Set(
            actions.map((entry) => (entry._tag === "action" ? entry.id : ""))
          );
          for (const entry of timeline.entries) {
            if (entry._tag === "keyframe") {
              expect(actionIds.has(entry.actionId ?? "")).toBe(true);
            }
          }
          const events = yield* fileSystem.readFileString(
            path.join(root, ".recordings", recordingId, "events.jsonl")
          );
          expect(events).not.toContain("Choose delivery area");
          expect(events).not.toContain("Select manually");
          expect(events).not.toContain('"kind":"fill"');
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
