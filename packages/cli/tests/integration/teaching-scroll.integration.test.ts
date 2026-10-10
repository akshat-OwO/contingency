import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import {
  AgentSession,
  SCROLL_PAUSE_MS,
} from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { registeredSleeps } from "../helpers/registered-sleeps.ts";
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
      // The pause runs on the test's clock, so no runner stall between notches
      // can split the gesture; the test moves the clock to close it.
      const clock = yield* TestClock.make();
      const sleeps = yield* registeredSleeps.pipe(
        Effect.provideService(Clock.Clock, clock)
      );
      const scrollClock = yield* sleeps.provide(
        Clock.clockWith(Effect.succeed)
      );

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
          // Nothing but Start, scroll, Stop: a user-led Teaching session takes
          // no Browser Snapshot of its own, so the gesture's evidence has to come
          // from the capture path itself.
          yield* scrollAsUser(started.id);
          // No photograph enters the input path while the pause clock is held.
          expect(screenshots).not.toHaveBeenCalled();
          if (close === "idle") {
            yield* sleeps
              .waitForSleep(SCROLL_PAUSE_MS)
              .pipe(Effect.provideService(Clock.Clock, clock));
            yield* clock.adjust(SCROLL_PAUSE_MS);
            yield* Deferred.await(photographed).pipe(
              Effect.timeout("30 seconds")
            );
            expect(screenshots).toHaveBeenCalledTimes(1);
          }
          yield* service.stopTeachingRecording(
            started.id,
            OperationId.make("scroll-stop-recording")
          );
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root, { scrollClock })))
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
          // Nothing the user can still see is reported gone. A container is
          // named by its own label rather than the text that just arrived in
          // it, so even the landmark around the catalogue keeps its line.
          expect(scroll?.disappeared).toEqual([]);
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
