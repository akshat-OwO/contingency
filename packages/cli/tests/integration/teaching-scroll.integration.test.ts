import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  sessionTool,
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

it.live("records one scroll gesture that reports what it revealed", () =>
  Effect.gen(function* recordOneScrollGesture() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-scroll-recording-",
    });
    const fixtures = yield* fixtureServer;

    const recordingId = yield* Effect.scoped(
      Effect.gen(function* demonstrateScrolling() {
        const started = yield* sessionTool("agent_session_start", {
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
        // Nothing but Start, scroll, Stop: a user-led Teaching session takes
        // no Browser Snapshot of its own, so the gesture's evidence has to come
        // from the capture path itself.
        yield* scrollAsUser(started.id);
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
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
