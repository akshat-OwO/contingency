import { OperationId } from "@contingency/protocol";
import type { AgentSessionId, KeyboardInput } from "@contingency/protocol";
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

/** Where the user's pointer lands on the fixture's Email field. */
const EMAIL_FIELD = { x: 120, y: 116 } as const;

const key = (sessionId: AgentSessionId, input: Omit<KeyboardInput, "type">) =>
  AgentSession.pipe(
    Effect.flatMap((service) =>
      service.sendInput(sessionId, { ...input, type: "input_keyboard" })
    )
  );

/** One key the way the Workspace canvas sends it: down, then up. */
const press = (sessionId: AgentSessionId, name: string, text: string) =>
  Effect.gen(function* pressKey() {
    yield* key(sessionId, { eventType: "keyDown", key: name, text });
    yield* key(sessionId, { eventType: "keyUp", key: name });
  });

/** A capital or a symbol: Shift is its own key press around it. */
const shifted = (sessionId: AgentSessionId, character: string) =>
  Effect.gen(function* pressShifted() {
    yield* key(sessionId, { eventType: "keyDown", key: "Shift" });
    yield* press(sessionId, character, character);
    yield* key(sessionId, { eventType: "keyUp", key: "Shift" });
  });

it.live("records typing into one field as one fill named by the field", () =>
  Effect.gen(function* recordOneFill() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-fill-",
    });
    const fixtures = yield* fixtureServer;

    yield* Effect.gen(function* demonstrateTyping() {
      const started = yield* sessionTool("agent_session_start", {
        activity: "teaching",
        clientName: "integration-recorder",
        clientVersion: "1.0.0",
        name: "type-email",
        operationId: OperationId.make("fill-start-session"),
        url: fixtures.url("typing.html"),
        viewport: agentViewport,
      });
      const { recordingId } = started;
      if (recordingId === null) {
        return yield* Effect.die("Teaching did not allocate a recording.");
      }
      const service = yield* AgentSession;
      yield* service.startTeachingRecording(
        started.id,
        OperationId.make("fill-start-recording")
      );
      for (const eventType of ["mousePressed", "mouseReleased"] as const) {
        yield* service.sendInput(started.id, {
          button: "left",
          clickCount: 1,
          eventType,
          type: "input_mouse",
          ...EMAIL_FIELD,
        });
      }
      yield* shifted(started.id, "A");
      for (const character of "da") {
        yield* press(started.id, character, character);
      }
      yield* shifted(started.id, "@");
      for (const character of "ex.orgg") {
        yield* press(started.id, character, character);
      }
      yield* key(started.id, {
        code: "Backspace",
        eventType: "keyDown",
        key: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      yield* key(started.id, { eventType: "keyUp", key: "Backspace" });
      // Stop straight after the last key: it must still be in the recording.
      yield* Effect.all(
        [
          press(started.id, "Enter", "\r"),
          service.stopTeachingRecording(
            started.id,
            OperationId.make("fill-stop-recording")
          ),
        ],
        { concurrency: "unbounded" }
      );

      const claimOperationId = OperationId.make("fill-claim");
      yield* teachingRecordingTool("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOperationId,
        recordingId,
      });
      const timeline = yield* teachingRecordingTool(
        "agent_teaching_timeline_get",
        { claimOperationId, recordingId }
      );
      const actions = timeline.entries.flatMap((entry) =>
        entry._tag === "action" ? [entry] : []
      );
      const fills = actions.filter((action) => action.kind === "fill");

      expect(fills.map((fill) => fill.description)).toEqual([
        'Fill textbox "Email" with "Ada@ex.org"',
      ]);
      expect(fills[0]?.target?.value).toBe("Ada@ex.org");
      // Shift on its own is not an action a reader could learn from.
      expect(actions.map((action) => action.kind)).toEqual([
        "click",
        "fill",
        "input",
      ]);
      for (const action of actions) {
        expect(action.description).not.toMatch(/\be\d+\b/u);
      }
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
