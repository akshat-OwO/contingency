import { createHash } from "node:crypto";
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

/** Where the user's pointer lands on each fixed control of the fixture. */
const CHOOSE_DELIVERY = { x: 120, y: 116 } as const;
const SELECT_MANUALLY = { x: 120, y: 176 } as const;
const CITY_FIELD = { x: 120, y: 116 } as const;

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

const typeAsUser = (sessionId: AgentSessionId, text: string) =>
  Effect.gen(function* typeAsTheUser() {
    const service = yield* AgentSession;
    for (const character of text) {
      yield* service.sendInput(sessionId, {
        eventType: "keyDown",
        key: character,
        text: character,
        type: "input_keyboard",
      });
      yield* service.sendInput(sessionId, {
        eventType: "keyUp",
        key: character,
        type: "input_keyboard",
      });
    }
  });

it.live(
  "photographs every recorded action and serves the keyframes one at a time",
  () =>
    Effect.gen(function* keyframeEveryRecordedAction() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-keyframe-",
      });
      const fixtures = yield* fixtureServer;

      const recordingId = yield* Effect.scoped(
        Effect.gen(function* demonstrateDeliveryJourney() {
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "set-delivery-area",
            operationId: OperationId.make("keyframe-start-session"),
            url: fixtures.url("delivery.html"),
            viewport: agentViewport,
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          const service = yield* AgentSession;
          yield* service.startTeachingRecording(
            started.id,
            OperationId.make("keyframe-start-recording")
          );
          const settle = sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          // Teaching is user-led throughout: nobody asks for a screenshot, so
          // every keyframe below has to come from capture itself.
          yield* clickAsUser(started.id, CHOOSE_DELIVERY);
          const choosing = yield* settle;
          findNode(choosing.nodes, "button", "Select manually");
          yield* clickAsUser(started.id, SELECT_MANUALLY);
          const picking = yield* settle;
          findNode(picking.nodes, "textbox", "Search for your delivery area");
          yield* clickAsUser(started.id, CITY_FIELD);
          yield* typeAsUser(started.id, "Gurugram");
          yield* service.stopTeachingRecording(
            started.id,
            OperationId.make("keyframe-stop-recording")
          );
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      const recordingDirectory = path.join(root, ".recordings", recordingId);
      const files = yield* fileSystem.readDirectory(recordingDirectory);
      const keyframeFiles = files.filter((name) => name.endsWith(".png"));
      expect(keyframeFiles.length).toBeGreaterThan(0);
      // Keyframes are raw Teaching evidence, so they are named by the local
      // retention manifest alongside the Trace and the video.
      const retentionName = files.find((name) =>
        name.endsWith(".artifacts.json")
      );
      if (retentionName === undefined) {
        return yield* Effect.die("The recording kept no retention manifest.");
      }
      const retention = yield* fileSystem.readFileString(
        path.join(recordingDirectory, retentionName)
      );
      expect(JSON.parse(retention)).toMatchObject({
        files: { keyframes: keyframeFiles.toSorted() },
        retention: "local",
        sensitive: true,
      });

      yield* Effect.scoped(
        Effect.gen(function* readKeyframesInLaterProcess() {
          const claimOperationId = OperationId.make("keyframe-claim");
          yield* teachingRecordingTool("agent_teaching_recording_claim", {
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
          const keyframes = timeline.entries.filter(
            (entry) => entry._tag === "keyframe"
          );
          expect(actions.length).toBeGreaterThan(1);
          // One recorded action, one keyframe: a coalesced gesture keeps the
          // single image of the state it left behind.
          expect(keyframes.length).toBeGreaterThanOrEqual(actions.length);
          // References only. A timeline that carried the bytes would spend a
          // learning agent's whole context on pixels.
          for (const keyframe of keyframes) {
            expect(Object.keys(keyframe).toSorted()).toEqual([
              "_tag",
              "actionId",
              "at",
              "hash",
              "id",
              "seq",
            ]);
          }
          expect(JSON.stringify(timeline)).not.toContain('"image"');

          const [keyframe] = keyframes;
          if (keyframe?._tag !== "keyframe") {
            return yield* Effect.die("The timeline referenced no keyframe.");
          }
          const fetched = yield* teachingRecordingTool(
            "agent_teaching_keyframe_get",
            { claimOperationId, keyframeId: keyframe.id, recordingId }
          );
          expect(fetched.hash).toBe(keyframe.hash);
          expect(
            `sha256-${createHash("sha256").update(fetched.image, "base64").digest("hex")}`
          ).toBe(keyframe.hash);

          const missing = yield* Effect.flip(
            teachingRecordingTool("agent_teaching_keyframe_get", {
              claimOperationId,
              keyframeId: "keyframe-nobody-recorded",
              recordingId,
            })
          );
          expect(missing.code).toBe("teaching_recording_not_found");

          const listed = yield* teachingRecordingTool(
            "agent_teaching_recordings_list",
            {}
          );
          expect(JSON.stringify(listed)).not.toContain(fetched.image);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
