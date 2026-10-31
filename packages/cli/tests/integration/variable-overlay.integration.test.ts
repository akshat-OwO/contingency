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
  "fills a Variable through the same transparent backdrop as ordinary fill",
  () =>
    Effect.gen(function* enterThroughBackdrop() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "variable-overlay-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* driveVariableEntry() {
          const service = yield* AgentSession;
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "overlay-test",
            clientVersion: "1",
            name: "variable-overlay",
            operationId: OperationId.make("start"),
            url: fixtures.url("variable-overlay.html"),
            viewport: agentViewport,
          });
          const sessionId = started.id;
          const requested = yield* sessionTool("agent_variable_request", {
            name: "MOBILE_NUMBER",
            operationId: OperationId.make("request"),
            purpose: "Sign in",
            replace: false,
            sessionId,
          });
          const request = requested.setupVariables?.[0];
          if (request === undefined) {
            return yield* Effect.die("Missing Variable request");
          }
          yield* service.answerSetupVariable({
            operationId: OperationId.make("supply"),
            requestId: request.requestId,
            sessionId,
            value: "5559876543",
          });
          const before = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const field = findNode(before.nodes, "textbox", "Mobile number");
          // The Snapshot offers the field, so the agent can reach it at all.
          expect(field.blockedBy).toBeUndefined();
          const { ref } = field;
          // Ordinary fill establishes the same observable acceptance contract.
          const ordinary = yield* sessionTool("agent_browser_act", {
            action: { ref, text: "5551234567", type: "fill" },
            operationId: OperationId.make("ordinary-fill"),
            sessionId,
          });
          expect(
            findNode(ordinary.snapshot.nodes, "textbox", "Mobile number").value
          ).toBe("5551234567");
          const entered = yield* sessionTool("agent_variable_enter", {
            name: "MOBILE_NUMBER",
            operationId: OperationId.make("variable-fill"),
            ref,
            sessionId,
          });
          expect(entered.entry.outcome).toBe("completed");
          expect(
            findNode(entered.snapshot.nodes, "textbox", "Mobile number").value
          ).toBe("5559876543");
          expect(entered.entry.description).toContain("{{MOBILE_NUMBER}}");
          expect(JSON.stringify(entered.entry)).not.toContain("5559876543");
          const history = yield* sessionTool("agent_session_get", {
            sessionId,
          });
          expect(history.timeline.at(-1)).toEqual(entered.entry);
          expect(JSON.stringify(history.timeline.at(-1))).not.toContain(
            "5559876543"
          );
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "refuses a field hidden by an opaque sheet with a transparent child",
  () =>
    Effect.gen(function* refuseBehindOpaqueSheet() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "variable-opaque-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* driveRefusedEntry() {
          const service = yield* AgentSession;
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "overlay-test",
            clientVersion: "1",
            name: "variable-opaque",
            operationId: OperationId.make("start"),
            url: fixtures.url("variable-opaque-sheet.html"),
            viewport: agentViewport,
          });
          const sessionId = started.id;
          const requested = yield* sessionTool("agent_variable_request", {
            name: "MOBILE_NUMBER",
            operationId: OperationId.make("request"),
            purpose: "Sign in",
            replace: false,
            sessionId,
          });
          const request = requested.setupVariables?.[0];
          if (request === undefined) {
            return yield* Effect.die("Missing Variable request");
          }
          yield* service.answerSetupVariable({
            operationId: OperationId.make("supply"),
            requestId: request.requestId,
            sessionId,
            value: "5559876543",
          });
          const before = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const field = findNode(before.nodes, "textbox", "Mobile number");
          expect(field.blockedBy).toBeDefined();
          const ordinary = yield* Effect.flip(
            sessionTool("agent_browser_act", {
              action: { ref: field.ref, text: "5551234567", type: "fill" },
              operationId: OperationId.make("ordinary-fill"),
              sessionId,
            })
          );
          expect(ordinary.reason).toBe("intercepted");
          yield* Effect.flip(
            sessionTool("agent_variable_enter", {
              name: "MOBILE_NUMBER",
              operationId: OperationId.make("variable-fill"),
              ref: field.ref,
              sessionId,
            })
          );
          const after = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          expect(
            findNode(after.nodes, "textbox", "Mobile number").value ?? ""
          ).toBe("");
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
