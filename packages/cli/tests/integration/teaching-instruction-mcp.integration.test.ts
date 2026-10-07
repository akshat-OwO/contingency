import { createServer } from "node:http";

import {
  AgentSessionSnapshot,
  OperationId,
  TeachingTimeline,
} from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { makeMcpHttpLayer } from "../../src/services/mcp-http.ts";
import { agentProcessLayer, agentViewport } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

it.live(
  "returns JSON-compatible Teaching instructions over MCP and persists them once",
  () =>
    Effect.gen(function* teachingInstructionsOverMcp() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const fixtures = yield* fixtureServer;
      const context = yield* Layer.build(
        HttpRouter.serve(
          makeMcpHttpLayer(new Set(["http://127.0.0.1:7777"]))
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(agentProcessLayer(root), makeDemoSiteLayer())
          ),
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
          )
        )
      );
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag === "UnixPathAddress") {
        return yield* Effect.die("Expected TCP server");
      }
      const origin = `http://127.0.0.1:${server.address.port}/mcp`;
      let mcpSessionId: string | null = null;
      let requestId = 0;
      const post = (method: string, params: Record<string, Schema.Json>) =>
        Effect.promise(async () => {
          const headers = new Headers({
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          });
          if (mcpSessionId !== null) {
            headers.set("mcp-session-id", mcpSessionId);
          }
          const response = await fetch(origin, {
            body: JSON.stringify({
              id: (requestId += 1),
              jsonrpc: "2.0",
              method,
              params,
            }),
            headers,
            method: "POST",
          });
          expect(response.status).toBe(200);
          mcpSessionId ??= response.headers.get("mcp-session-id");
          const payload: unknown = await response.json();
          return payload;
        });
      yield* post("initialize", {
        capabilities: {},
        clientInfo: { name: "teaching-regression", version: "1" },
        protocolVersion: "2025-06-18",
      });
      yield* Effect.promise(() =>
        fetch(origin, {
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
            "mcp-session-id": mcpSessionId ?? "",
          },
          method: "POST",
        })
      );
      const call = (name: string, args: Record<string, Schema.Json>) =>
        Effect.gen(function* callMcpTool() {
          const payload = yield* post("tools/call", { arguments: args, name });
          expect(payload, JSON.stringify(payload)).toHaveProperty("result");
          const response = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ result: McpSchema.CallToolResult })
          )(payload);
          expect(response.result.isError, name).not.toBe(true);
          return response.result.structuredContent;
        });
      const started = yield* Schema.decodeUnknownEffect(AgentSessionSnapshot)(
        yield* call("agent_session_start", {
          activity: "teaching",
          clientName: "regression",
          clientVersion: "1",
          name: "mcp-instructions",
          operationId: "instruction-start",
          url: fixtures.url("agent-login.html"),
          viewport: agentViewport,
        })
      );
      yield* call("agent_teaching_setup_handoff", {
        operationId: "instruction-handoff",
        sessionId: started.id,
      });
      const sessions = Context.get(context, AgentSession);
      yield* sessions.startTeachingRecording(
        started.id,
        OperationId.make("instruction-recording")
      );
      const plain = {
        operationId: "instruction-plain",
        sessionId: started.id,
        text: "Use the express checkout here.",
      };
      const recorded = yield* Schema.decodeUnknownEffect(AgentSessionSnapshot)(
        yield* call("agent_teaching_instruction_record", plain)
      );
      expect(recorded.teaching?.instructions).toHaveLength(1);
      expect(recorded.teaching?.instructions[0]).not.toHaveProperty("scan");
      yield* call("agent_teaching_instruction_record", plain);
      const scan = {
        id: "checkout-a11y",
        mode: "accessibility",
        phase: "start",
      };
      yield* call("agent_teaching_instruction_record", {
        operationId: "instruction-scan",
        scan,
        sessionId: started.id,
        text: "Check checkout accessibility.",
      });
      for (const view of [undefined, "full"] as const) {
        const full = yield* Schema.decodeUnknownEffect(AgentSessionSnapshot)(
          yield* call(
            "agent_session_get",
            view === undefined
              ? { sessionId: started.id }
              : { sessionId: started.id, view }
          )
        );
        expect(full.teaching?.instructions).toHaveLength(2);
        expect(full.teaching?.instructions[0]?.text).toBe(plain.text);
        expect(full.teaching?.instructions[1]?.scan).toEqual(scan);
      }
      expect(
        yield* call("agent_session_get", {
          sessionId: started.id,
          view: "compact",
        })
      ).toMatchObject({ teaching: { instructionCount: 2 } });
      yield* sessions.stopTeachingRecording(
        started.id,
        OperationId.make("instruction-stop")
      );
      yield* call("agent_session_get", { sessionId: started.id, view: "full" });
      yield* call("agent_teaching_recording_claim", {
        action: "take",
        operationId: "instruction-claim",
        recordingId: started.recordingId,
      });
      const timeline = yield* Schema.decodeUnknownEffect(TeachingTimeline)(
        yield* call("agent_teaching_timeline_get", {
          claimOperationId: "instruction-claim",
          recordingId: started.recordingId,
        })
      );
      const instructions = timeline.entries.filter(
        (entry) => entry._tag === "instruction"
      );
      expect(instructions).toHaveLength(2);
      expect(instructions[0]).toMatchObject({ text: plain.text });
      expect(instructions[0]).not.toHaveProperty("scan");
      expect(instructions[1]).toMatchObject({ scan });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
