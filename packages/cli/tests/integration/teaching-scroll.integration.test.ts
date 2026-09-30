import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { vi } from "vitest";

import { AgentSession } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  agentProcessLayer,
  agentViewport,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Roughly one trackpad flick: the browser sees each notch separately. */
const WHEEL_EVENTS = 40;

const scrollAsUser = (sessionId: AgentSessionId) =>
  Effect.gen(function* scrollAsTheUser() {
    const service = yield* AgentSession;
    for (let notch = 0; notch < WHEEL_EVENTS; notch += 1) {
      yield* service.sendInput(sessionId, {
        deltaX: 0,
        deltaY: 120,
        eventType: "mouseWheel",
        type: "input_mouse",
        x: 320,
        y: 240,
      });
      yield* Effect.sleep(25);
    }
  });

it.live.each(["idle", "stop"])(
  "records one scroll gesture closed by %s",
  (close) =>
    Effect.gen(function* recordOneScrollGesture() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-scroll-recording-",
      });
      const fixtures = yield* fixtureServer;

      const recordingId = yield* Effect.scoped(
        Effect.gen(function* demonstrateScrolling() {
          const started = yield* startUserTeaching({
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "read-catalogue",
            operationId: OperationId.make("scroll-start-session"),
            url: fixtures.url("lazy.html"),
            viewport: agentViewport,
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          const service = yield* AgentSession;
          yield* service.startTeachingRecording(
            started.id,
            OperationId.make("scroll-start-recording")
          );
          const browser = yield* CreateBrowser;
          const [browserId] = yield* browser.list();
          if (browserId === undefined) {
            return yield* Effect.die("Teaching did not open a browser.");
          }
          const page = yield* browser.activePage(browserId);
          // Observe the real screenshot API; the browser and capture still run.
          const screenshots = vi.spyOn(page, "screenshot");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => screenshots.mockRestore())
          );
          // Nothing but Start, scroll, Stop: a user-led Teaching session takes
          // no Browser Snapshot of its own, so the gesture's evidence has to come
          // from the capture path itself.
          yield* scrollAsUser(started.id);
          // A gesture longer than the old 750ms keyframe interval must never
          // take a PNG in the input path. Capture resumes after a quiet pause.
          expect(screenshots).not.toHaveBeenCalled();
          if (close === "idle") {
            yield* Effect.sleep(500);
            expect(screenshots).toHaveBeenCalledTimes(1);
          }
          yield* service.stopTeachingRecording(
            started.id,
            OperationId.make("scroll-stop-recording")
          );
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      yield* Effect.scoped(
        Effect.gen(function* readTheTimeline() {
          const claimOperationId = OperationId.make("scroll-claim");
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

          // Forty wheel notches were one gesture, and the whole demonstration
          // fits in one page rather than burying the real steps.
          expect(actions).toHaveLength(1);
          expect(timeline.nextCursor).toBeNull();
          const [scroll] = actions;
          expect(scroll?.description).toBe("The user scrolled the Page");
          // The tree the gesture started from, observed on its first notch.
          expect(scroll?.before.nodeCount).toBeGreaterThan(0);
          // Scrolling revealed the catalogue, and the gesture is credited with
          // it: the after state is the Page the user stopped on, not an empty
          // tree.
          expect(scroll?.after.nodeCount).toBeGreaterThan(
            scroll?.before.nodeCount ?? 0
          );
          expect(scroll?.appeared.map(({ name }) => name)).toEqual(
            expect.arrayContaining(["Anvil", "Bellows", "Chisel"])
          );
          // Nothing the user can still see is reported gone. The one exception
          // is the container whose accessible name is computed from the text
          // that just arrived, so its old name really is no longer on the Page.
          expect(scroll?.disappeared.map(({ role }) => role)).toEqual(["main"]);
          const keyframe = timeline.entries.find(
            (entry) =>
              entry._tag === "keyframe" && entry.actionId === scroll?.id
          );
          if (keyframe?._tag !== "keyframe") {
            return yield* Effect.die(
              "The scroll gesture retained no keyframe."
            );
          }
          const image = yield* teachingRecordingTool(
            "agent_teaching_keyframe_get",
            {
              claimOperationId,
              keyframeId: keyframe.id,
              recordingId,
            }
          );
          expect((yield* fileSystem.readFile(image.path)).byteLength).toBe(
            image.bytes
          );
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
