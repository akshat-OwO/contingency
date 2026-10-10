import { createHash } from "node:crypto";
import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem } from "effect";
import { vi } from "vitest";

import { AgentSession } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import {
  fixtureServer,
  TEACHING_RENDER_GATE,
  TEACHING_RENDERED_BEACON,
} from "./harness.ts";

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
          const started = yield* startUserTeaching({
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
              "url",
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
          expect(fetched.path).toBe(
            path.join(recordingDirectory, `${keyframe.id}.png`)
          );
          const bytes = yield* fileSystem.readFile(fetched.path);
          expect(fetched.bytes).toBe(bytes.byteLength);
          expect(
            `sha256-${createHash("sha256").update(bytes).digest("hex")}`
          ).toBe(keyframe.hash);
          expect(JSON.stringify(fetched)).not.toContain('"image"');

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
          expect(JSON.stringify(listed)).not.toContain(fetched.path);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const delayed of [false, true]) {
  it.live(
    `preserves transitional navigation evidence with ${delayed ? "held" : "immediate"} rendering`,
    () =>
      Effect.gen(function* recordNavigationEvidence() {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "contingency-navigation-keyframe-",
        });
        const fixtures = yield* fixtureServer;
        const gate = delayed
          ? yield* fixtures.holdRequest(TEACHING_RENDER_GATE)
          : undefined;
        const rendered = yield* fixtures.awaitRequest(
          (url) => url === TEACHING_RENDERED_BEACON
        );
        const recordingId = yield* Effect.scoped(
          Effect.gen(function* clickWhileRecording() {
            const started = yield* startUserTeaching({
              activity: "teaching",
              clientName: "integration-recorder",
              clientVersion: "1.0.0",
              name: "navigation-evidence",
              operationId: OperationId.make("navigation-start-session"),
              url: `${fixtures.url("teaching-navigation.html")}${delayed ? "?delayed" : ""}`,
              viewport: { deviceScaleFactor: 3, height: 844, width: 390 },
            });
            if (started.recordingId === null) {
              return yield* Effect.die(
                "Teaching did not allocate a recording."
              );
            }
            const service = yield* AgentSession;
            yield* service.startTeachingRecording(
              started.id,
              OperationId.make("navigation-start-recording")
            );
            const browser = yield* CreateBrowser;
            const [browserId] = yield* browser.list();
            if (browserId === undefined) {
              return yield* Effect.die("Teaching did not open a browser.");
            }
            const page = yield* browser.activePage(browserId);
            // The click's keyframe must show the Page before the delayed render,
            // so the render waits until that screenshot has been taken.
            const photographed = yield* Deferred.make<true>();
            const screenshot = page.screenshot.bind(page);
            const screenshots = vi
              .spyOn(page, "screenshot")
              .mockImplementation(async (...args) => {
                const image = await screenshot(...args);
                await Effect.runPromise(Deferred.succeed(photographed, true));
                return image;
              });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => screenshots.mockRestore())
            );
            yield* clickAsUser(started.id, { x: 120, y: 288 });
            // Let the delayed Page finish before Stop: later rendering must not
            // turn the earlier PNG into evidence of the final destination.
            if (gate !== undefined) {
              yield* Deferred.await(gate.arrived).pipe(
                Effect.timeout("30 seconds")
              );
              yield* Deferred.await(photographed).pipe(
                Effect.timeout("30 seconds")
              );
              yield* Deferred.succeed(gate.release, true);
            }
            yield* Deferred.await(rendered).pipe(Effect.timeout("30 seconds"));
            const settled = yield* sessionTool("agent_browser_snapshot", {
              sessionId: started.id,
            });
            findNode(settled.nodes, "heading", "User profile");
            yield* service.stopTeachingRecording(
              started.id,
              OperationId.make("navigation-stop-recording")
            );
            return started.recordingId;
          }).pipe(Effect.provide(agentProcessLayer(root)))
        );
        yield* Effect.scoped(
          Effect.gen(function* readNavigationInLaterProcess() {
            const claimOperationId = OperationId.make("navigation-claim");
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
            expect(actions).toHaveLength(1);
            const [action] = actions;
            expect(action).toMatchObject({
              after: { capture: "transitional" },
              description: 'Click button "View details"',
              kind: "click",
            });
            expect(action?.after.url).toContain("?profile");
            if (delayed) {
              expect(action?.appeared).toEqual([]);
              expect(action?.disappeared).toEqual([]);
            }
            const keyframes = timeline.entries.filter(
              (entry) => entry._tag === "keyframe"
            );
            expect(keyframes).toHaveLength(1);
            const [keyframe] = keyframes;
            if (keyframe === undefined) {
              return yield* Effect.die("The navigation kept no keyframe.");
            }
            expect(keyframe).toMatchObject({
              actionId: action?.id,
              capture: "transitional",
              url: action?.after.url,
            });
            const file = yield* teachingRecordingTool(
              "agent_teaching_keyframe_get",
              { claimOperationId, keyframeId: keyframe.id, recordingId }
            );
            const bytes = yield* fileSystem.readFile(file.path);
            expect(
              `sha256-${createHash("sha256").update(bytes).digest("hex")}`
            ).toBe(keyframe.hash);
          }).pipe(Effect.provide(agentProcessLayer(root)))
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
