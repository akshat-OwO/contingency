import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

it.live(
  "reloads the actual browser after a one-character setup value masks its reported URL",
  () =>
    Effect.gen(function* shortSetupValue() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-short-setup-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* enterAndReload() {
          const service = yield* AgentSession;
          const session = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "short-value",
            clientVersion: "1",
            name: "short-private-setup",
            operationId: OperationId.make("short-start"),
            url: fixtures.url("agent-login.html"),
            viewport: agentViewport,
          });
          const requested = yield* service.requestSetupVariable({
            name: "PIN",
            operationId: OperationId.make("short-request"),
            purpose: "Prepare private setup",
            replace: false,
            sessionId: session.id,
          });
          const request = requested.setupVariables?.[0];
          if (request === undefined) {
            return yield* Effect.die("Missing setup request");
          }
          yield* service.answerSetupVariable({
            operationId: OperationId.make("short-supply"),
            requestId: request.requestId,
            sessionId: session.id,
            value: "1",
          });
          const page = yield* sessionTool("agent_browser_snapshot", {
            sessionId: session.id,
          });
          const entered = yield* service.enterSuppliedVariable(
            session.id,
            "PIN",
            findNode(page.nodes, "textbox", "Display name").ref,
            OperationId.make("short-enter")
          );
          expect(entered.entry.outcome).toBe("completed");
          expect(entered.url).toContain("[sensitive input]");
          const reloaded = yield* sessionTool("agent_browser_act", {
            action: { action: "reload", type: "history" },
            operationId: OperationId.make("short-reload"),
            sessionId: session.id,
          });
          expect(reloaded.entry.outcome).toBe("completed");
          findNode(reloaded.snapshot.nodes, "button", "Sign in");
          yield* service.handOffTeachingSetup(
            session.id,
            OperationId.make("short-handoff")
          );
          yield* service.startTeachingRecording(
            session.id,
            OperationId.make("short-record")
          );
          const recording = yield* service.get(session.id);
          expect(recording).toMatchObject({
            captureState: { _tag: "recording" },
            controller: "user",
          });
          yield* service.stopTeachingRecording(
            session.id,
            OperationId.make("short-stop")
          );
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
