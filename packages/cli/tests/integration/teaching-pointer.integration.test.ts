import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Roughly one sweep of the pointer: the Workspace sends a move per frame. */
const POINTER_MOVES = 40;

it.live("leaves pointer moves out of the session timeline", () =>
  Effect.gen(function* leavePointerMovesOut() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-pointer-timeline-",
    });
    const fixtures = yield* fixtureServer;

    yield* Effect.gen(function* moveThenClick() {
      const started = yield* sessionTool("agent_session_start", {
        activity: "teaching",
        clientName: "integration-recorder",
        clientVersion: "1.0.0",
        name: "sweep-the-pointer",
        operationId: OperationId.make("pointer-start-session"),
        url: fixtures.url("hover.html"),
        viewport: agentViewport,
      });
      const service = yield* AgentSession;
      for (let move = 0; move < POINTER_MOVES; move += 1) {
        yield* service.sendInput(started.id, {
          eventType: "mouseMoved",
          type: "input_mouse",
          x: 10 + move * 5,
          y: 10 + move * 5,
        });
      }
      for (const eventType of ["mousePressed", "mouseReleased"] as const) {
        yield* service.sendInput(started.id, {
          button: "left",
          clickCount: 1,
          eventType,
          type: "input_mouse",
          x: 210,
          y: 210,
        });
      }

      const session = yield* sessionTool("agent_session_get", {
        sessionId: started.id,
      });
      const descriptions = session.timeline.map((entry) => entry.description);
      // The sweep was no step, so the click that followed it is what the
      // timeline shows rather than forty moves ahead of it (#267).
      expect(
        descriptions.filter((text) => text.includes("mouseMoved"))
      ).toEqual([]);
      expect(descriptions).toEqual(
        expect.arrayContaining([
          "The user sent a mousePressed browser input",
          "The user sent a mouseReleased browser input",
        ])
      );
    }).pipe(Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
