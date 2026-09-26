import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Where the user's pointer lands on the fixture's fixed Password field. */
const PASSWORD_FIELD = { x: 280, y: 152 } as const;
const PASSWORD = "secret_sauce";

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

it.live("records typing into a password field as one withheld fill", () =>
  Effect.gen(function* recordPasswordFill() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-password-recording-",
    });
    const fixtures = yield* fixtureServer;

    const recordingId = yield* Effect.scoped(
      Effect.gen(function* demonstrateSignIn() {
        const started = yield* startUserTeaching({
          activity: "teaching",
          clientName: "integration-recorder",
          clientVersion: "1.0.0",
          name: "sign-in",
          operationId: OperationId.make("password-start-session"),
          url: fixtures.url("sign-in.html"),
          viewport: agentViewport,
        });
        if (started.recordingId === null) {
          return yield* Effect.die("Teaching did not allocate a recording.");
        }
        const service = yield* AgentSession;
        yield* service.startTeachingRecording(
          started.id,
          OperationId.make("password-start-recording")
        );
        yield* typeAsUser(started.id, "standard_user");
        yield* clickAsUser(started.id, PASSWORD_FIELD);
        yield* typeAsUser(started.id, PASSWORD);
        yield* service.stopTeachingRecording(
          started.id,
          OperationId.make("password-stop-recording")
        );
        return started.recordingId;
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );

    yield* Effect.scoped(
      Effect.gen(function* readTheTimeline() {
        const claimOperationId = OperationId.make("password-claim");
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

        // Username fill, the click into Password, and one Password fill: no
        // keystroke survives as a raw keyboard input.
        expect(actions.map((action) => action.kind)).toEqual([
          "fill",
          "click",
          "fill",
        ]);
        const password = actions.at(-1);
        expect(password?.target).toMatchObject({
          name: "Password",
          role: "textbox",
          value: "[sensitive input]",
          valueWithheld: true,
        });
        expect(password?.before.nodeCount).toBeGreaterThan(0);
        expect(password?.after.nodeCount).toBeGreaterThan(0);
        expect(password?.after.title).toBe("Sign in");
        expect(JSON.stringify(timeline)).not.toContain(PASSWORD);
      }).pipe(Effect.provide(agentProcessLayer(root)))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
