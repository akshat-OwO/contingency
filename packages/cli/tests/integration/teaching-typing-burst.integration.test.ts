import { OperationId } from "@contingency/protocol";
import type { AgentSessionId, KeyboardInput } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  sessionTool,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Where the user's pointer lands on the fixture's fixed fields. */
const MOBILE_FIELD = { x: 120, y: 116 } as const;
const SEARCH_FIELD = { x: 120, y: 176 } as const;

const key = (sessionId: AgentSessionId, input: Omit<KeyboardInput, "type">) =>
  AgentSession.pipe(
    Effect.flatMap((service) =>
      service.sendInput(sessionId, { ...input, type: "input_keyboard" })
    )
  );

/** One key the way the Workspace canvas sends it, timed from down to up. */
const press = (sessionId: AgentSessionId, name: string, text: string) =>
  Effect.gen(function* pressKey() {
    yield* key(sessionId, { eventType: "keyDown", key: name, text });
    yield* key(sessionId, { eventType: "keyUp", key: name });
  }).pipe(
    Effect.timed,
    Effect.map(([duration]) => Duration.toMillis(duration))
  );

const click = (
  sessionId: AgentSessionId,
  at: { readonly x: number; readonly y: number }
) =>
  Effect.gen(function* clickAsUser() {
    const service = yield* AgentSession;
    for (const eventType of ["mousePressed", "mouseReleased"] as const) {
      yield* service.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        ...at,
      });
    }
  });

const startRecording = (name: string) =>
  Effect.gen(function* startTeachingRecording() {
    const fixtures = yield* fixtureServer;
    const started = yield* startUserTeaching({
      activity: "teaching",
      clientName: "integration-recorder",
      clientVersion: "1.0.0",
      name,
      operationId: OperationId.make(`${name}-start-session`),
      url: fixtures.url("typing-burst.html"),
      viewport: agentViewport,
    });
    const { recordingId } = started;
    if (recordingId === null) {
      return yield* Effect.die("Teaching did not allocate a recording.");
    }
    const service = yield* AgentSession;
    yield* service.startTeachingRecording(
      started.id,
      OperationId.make(`${name}-start-recording`)
    );
    return { recordingId, sessionId: started.id };
  });

const recordedEntries = (
  name: string,
  sessionId: AgentSessionId,
  recordingId: Parameters<
    typeof teachingRecordingTool<"agent_teaching_recording_claim">
  >[1]["recordingId"]
) =>
  Effect.gen(function* readRecordedEntries() {
    const service = yield* AgentSession;
    yield* service.stopTeachingRecording(
      sessionId,
      OperationId.make(`${name}-stop-recording`)
    );
    const claimOperationId = OperationId.make(`${name}-claim`);
    yield* teachingRecordingTool("agent_teaching_recording_claim", {
      action: "take",
      operationId: claimOperationId,
      recordingId,
    });
    const timeline = yield* teachingRecordingTool(
      "agent_teaching_timeline_get",
      { claimOperationId, recordingId }
    );
    return timeline.entries;
  });

const actionsOf = (
  entries: Effect.Success<ReturnType<typeof recordedEntries>>
) => entries.flatMap((entry) => (entry._tag === "action" ? [entry] : []));

it.live(
  "sends each key typed into a field without waiting on a Browser Snapshot",
  () =>
    Effect.gen(function* typeWithoutWaiting() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-typing-burst-",
      });

      yield* Effect.gen(function* typeAMobileNumber() {
        const { recordingId, sessionId } =
          yield* startRecording("typing-burst");
        // What one read of this Page costs: every key used to pay it twice.
        const [snapshotDuration] = yield* Effect.timed(
          sessionTool("agent_browser_snapshot", { sessionId })
        );
        const snapshotMillis = Duration.toMillis(snapshotDuration);
        yield* click(sessionId, MOBILE_FIELD);
        const keyMillis: number[] = [];
        for (const digit of "9876543210") {
          keyMillis.push(yield* press(sessionId, digit, digit));
        }

        // The first key observes the field the burst types into; every key
        // after it goes straight to the Page. Together they cost less than
        // one read of it, where each of them alone used to cost two.
        const [, ...following] = keyMillis;
        const typing = following.reduce((total, next) => total + next, 0);
        expect(typing).toBeLessThan(snapshotMillis);

        // The tenth digit moved focus on to Search, and the number stays
        // what was typed into Mobile number.
        const actions = actionsOf(
          yield* recordedEntries("typing-burst", sessionId, recordingId)
        );
        expect(actions.map((action) => action.kind)).toEqual(["click", "fill"]);
        const [, fill] = actions;
        expect(fill?.description).toBe(
          'Fill textbox "Mobile number" with "9876543210"'
        );
        expect(fill?.target?.value).toBe("9876543210");
        expect(fill?.before.nodeCount).toBeGreaterThan(0);
        expect(fill?.after.nodeCount).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "records typing once it pauses, ahead of the Enter that submits it",
  () =>
    Effect.gen(function* recordTypingThenSubmit() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-typing-pause-",
      });

      yield* Effect.gen(function* searchAndSubmit() {
        const { recordingId, sessionId } =
          yield* startRecording("typing-pause");
        yield* click(sessionId, SEARCH_FIELD);
        for (const character of "tablets") {
          yield* press(sessionId, character, character);
        }
        yield* Effect.sleep("1500 millis");

        // Nothing followed the typing, and the Fill is already recorded.
        const session = yield* sessionTool("agent_session_get", { sessionId });
        expect(session.timeline.map((entry) => entry.description)).toContain(
          'Fill textbox "Search" with "tablets"'
        );

        yield* key(sessionId, {
          code: "Enter",
          eventType: "keyDown",
          key: "Enter",
          text: "\r",
          windowsVirtualKeyCode: 13,
        });
        yield* key(sessionId, {
          code: "Enter",
          eventType: "keyUp",
          key: "Enter",
        });
        const actions = actionsOf(
          yield* recordedEntries("typing-pause", sessionId, recordingId)
        );
        expect(actions.map((action) => action.kind)).toEqual([
          "click",
          "fill",
          "input",
        ]);
        const [, fill, enter] = actions;
        expect(fill?.description).toBe('Fill textbox "Search" with "tablets"');
        expect(enter?.description).toContain("keyDown");
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
