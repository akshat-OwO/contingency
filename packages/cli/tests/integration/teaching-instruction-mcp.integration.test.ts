import { createServer } from "node:http";

import {
  AgentSessionSnapshot,
  OperationId,
  TeachingTimeline,
} from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { makeMcpHttpLayer } from "../../src/services/mcp-http.ts";
import { connectMcp } from "../helpers/mcp-http.ts";
import { agentProcessLayer, agentViewport } from "./agent-process.ts";
import { fixtureServer } from "./harness.ts";
import { mcpProgram } from "./scripted-agent.ts";

it.live(
  "returns JSON-compatible Teaching instructions over MCP and persists them once",
  () =>
    Effect.gen(function* teachingInstructionsOverMcp() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const fixtures = yield* fixtureServer;
      const context = yield* Layer.build(
        HttpRouter.serve(
          makeMcpHttpLayer(new Set(["http://127.0.0.1:7777"]), {})
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
      const { request } = yield* connectMcp(
        `http://127.0.0.1:${server.address.port}`
      );
      const { call } = mcpProgram(request);
      const started = yield* Schema.decodeUnknownEffect(AgentSessionSnapshot)(
        yield* call("agent_session_start", {
          activity: "teaching",
          clientName: "regression",
          clientVersion: "1",
          group: "",
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
      const cursorSnapshot = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ eventCursor: Schema.String })
      )(yield* call("agent_session_get", { sessionId: started.id }));
      for (const view of [undefined, "full"] as const) {
        const input = {
          afterCursor: cursorSnapshot.eventCursor,
          sessionId: started.id,
          waitMs: 0,
        };
        expect(
          yield* call(
            "agent_session_get",
            view === undefined ? input : { ...input, view }
          )
        ).toMatchObject({
          teaching: { instructionCount: 2 },
          view: "compact",
        });
      }
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
