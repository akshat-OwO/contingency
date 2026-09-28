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
  startUserTeaching,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Where the user's pointer lands on the fixture's fixed Remove button. */
const REMOVE_BACKUP = { x: 480, y: 35 } as const;
const OTP = "482915";
const OTP_VARIABLE = { name: "OTP", runtime: true, secret: true } as const;

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

it.live(
  "accepts a private Variable the page spread across one-character boxes",
  () =>
    Effect.gen(function* enterSpreadCode() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-private-input-",
      });
      const fixtures = yield* fixtureServer;

      yield* Effect.scoped(
        Effect.gen(function* demonstrateCodeEntry() {
          const started = yield* startUserTeaching({
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "spread-otp",
            operationId: OperationId.make("spread-start-session"),
            url: fixtures.url("spread-otp.html"),
            viewport: agentViewport,
          });
          const session = yield* AgentSession;
          yield* session.startTeachingRecording(
            started.id,
            OperationId.make("spread-start-recording")
          );
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          const firstBox = findNode(
            observed.nodes,
            "textbox",
            "otp-input 1 of 6"
          );
          const rejected = findNode(observed.nodes, "textbox", "Rejected code");
          const backup = findNode(observed.nodes, "textbox", "Backup code");

          // The boxes differ in markup, so the value is typed into the first
          // one alone and the page moves the rest into the boxes after it.
          const entered = yield* session.enterUserVariable(
            started.id,
            { ref: firstBox.ref, value: OTP, variable: OTP_VARIABLE },
            OperationId.make("spread-enter-otp")
          );
          expect(entered.entry.outcome).toBe("completed");
          expect(
            entered.snapshot.nodes.filter(
              (node) =>
                node.role === "textbox" && node.name.startsWith("otp-input")
            )
          ).toHaveLength(6);
          findNode(entered.snapshot.nodes, "button", "Continue");
          expect(JSON.stringify(entered)).not.toContain(OTP);

          const refused = yield* Effect.flip(
            session.enterUserVariable(
              started.id,
              {
                ref: rejected.ref,
                value: "731904",
                variable: { name: "REJECTED", runtime: true, secret: true },
              },
              OperationId.make("spread-enter-rejected")
            )
          );
          expect(refused.message).toBe(
            "Could not enter the private Variable (value_mismatch)."
          );

          yield* clickAsUser(started.id, REMOVE_BACKUP);
          const detached = yield* Effect.flip(
            session.enterUserVariable(
              started.id,
              {
                ref: backup.ref,
                value: "550127",
                variable: { name: "BACKUP", runtime: true, secret: true },
              },
              OperationId.make("spread-enter-backup")
            )
          );
          expect(detached.message).toBe(
            "Could not enter the private Variable (detached)."
          );
          expect(JSON.stringify([refused, detached])).not.toMatch(
            /731904|550127/u
          );

          const timeline = yield* sessionTool("agent_session_get", {
            sessionId: started.id,
          });
          const serialized = JSON.stringify(timeline);
          expect(serialized).not.toContain(OTP);
          expect(serialized).not.toMatch(/731904|550127/u);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
