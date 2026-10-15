import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { makeMcpHttpLayer } from "../../src/services/mcp-http.ts";
import { connectMcp } from "../helpers/mcp-http.ts";
import { agentProcessLayer } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

// One hang guard per test, sized for a hung browser rather than the work.
const HANG_GUARD_MS = 120_000;

const Execution = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    structuredContent: Schema.Struct({
      intervention: Schema.optional(
        Schema.Struct({
          operation: Schema.String,
          pending: Schema.Array(
            Schema.Struct({
              boundaryId: Schema.NullOr(Schema.String),
              kind: Schema.String,
              pendingDecisionId: Schema.String,
            })
          ),
          reasons: Schema.Array(Schema.String),
          sessionId: Schema.String,
        })
      ),
      receipts: Schema.Array(
        Schema.Struct({
          operation: Schema.String,
          operationId: Schema.NullOr(Schema.String),
          outcome: Schema.String,
        })
      ),
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});

const Resumed = Schema.Struct({
  entry: Schema.Struct({ dispatched: Schema.Boolean, id: Schema.String }),
});

it.live(
  "ends a program at an intervention and resumes only the exact attempt in a new one",
  () =>
    Effect.gen(function* interventionAcrossExecutions() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-single-tool-",
      });
      const fixture = yield* fixtureServer;
      const context = yield* Layer.build(
        HttpRouter.serve(
          makeMcpHttpLayer(new Set(["http://127.0.0.1:7777"]), {
            interface: "single-tool",
          })
        ).pipe(
          Layer.provideMerge(agentProcessLayer(root)),
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
          )
        )
      );
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag === "UnixPathAddress") {
        return yield* Effect.die("Expected a TCP server.");
      }
      const { request } = yield* connectMcp(
        `http://127.0.0.1:${server.address.port}`
      );
      const execute = (code: string) =>
        request("tools/call", {
          arguments: { code },
          name: "agent_code_execute",
        }).pipe(
          Effect.map(
            (body) =>
              Schema.decodeUnknownSync(Execution)(body).result.structuredContent
          )
        );

      // Start, read, and act in one program: the irreversible click opens a
      // Confirmation, and the read after it is never dispatched.
      const paused = yield* execute(`
        const run = await tools.agent_run_start({
          inputs: [],
          operationId: "single-tool-start",
          referencedSkills: [],
          requestedTask: "Add an anvil to the cart",
          url: ${JSON.stringify(fixture.url("task-session.html"))},
          view: "compact",
        });
        const page = await tools.agent_browser_snapshot({ sessionId: run.id, format: "structured" });
        const add = page.nodes.find((node) => node.role === "button" && node.name.includes("Add anvil"));
        await tools.agent_browser_act({
          action: { ref: add.ref, type: "click" },
          intent: { irreversible: true, objective: "Add an anvil" },
          operationId: "single-tool-click",
          sessionId: run.id,
        });
        await tools.agent_browser_snapshot({ sessionId: run.id });
        return "unreachable";
      `);
      expect(paused.status).toBe("intervention");
      expect(paused.receipts.map(({ operation }) => operation)).toEqual([
        "agent_run_start",
        "agent_browser_snapshot",
        "agent_browser_act",
      ]);
      const { intervention } = paused;
      expect(intervention?.operation).toBe("agent_browser_act");
      expect(intervention?.reasons).toContain("boundary");
      const [decision] = intervention?.pending ?? [];
      expect(decision?.kind).toBe("boundary");
      const sessionId = intervention?.sessionId ?? "missing";
      const boundaryId = decision?.boundaryId ?? "missing";

      // The user's explicit choice, relayed, then two concurrent executions
      // resume the same boundary: one dispatch, one shared result.
      const allowed = yield* execute(`
        await tools.agent_pending_decision_resolve({
          decision: "allow",
          operationId: "single-tool-allow",
          pendingDecisionId: ${JSON.stringify(decision?.pendingDecisionId)},
        });
        return null;
      `);
      expect(allowed.status).toBe("completed");
      const resume = `return await tools.agent_browser_resume(${JSON.stringify({
        boundaryId,
        sessionId,
      })})`;
      const resumed = yield* Effect.all([execute(resume), execute(resume)], {
        concurrency: "unbounded",
      });
      const [first, second] = resumed.map(({ status, value }) => {
        expect(status).toBe("completed");
        return Schema.decodeUnknownSync(Resumed)(value).entry;
      });
      expect(first?.dispatched).toBe(true);
      expect(second?.id).toBe(first?.id);
      // Repeating the original attempt reads its recorded outcome; nothing
      // is dispatched again.
      const replayed = yield* execute(`
        const sessionId = ${JSON.stringify(sessionId)};
        const page = await tools.agent_browser_snapshot({ sessionId, format: "structured" });
        const add = page.nodes.find((node) => node.role === "button" && node.name.includes("Add anvil"));
        const replay = await tools.agent_browser_act({
          action: { ref: add.ref, type: "click" },
          format: "structured",
          intent: { irreversible: true, objective: "Add an anvil" },
          operationId: "single-tool-click",
          sessionId,
        });
        return {
          cart: replay.snapshot.nodes.filter((node) => node.name.includes("Cart has")).map((node) => node.name),
          id: replay.entry.id,
        };
      `);
      expect(replayed.status).toBe("completed");
      expect(replayed.value).toEqual({
        cart: [expect.stringContaining("Cart has 1 items")],
        id: first?.id,
      });

      // Takeover is an intervention too: nothing after it runs.
      const takeover = yield* execute(`
        await tools.agent_session_takeover_request({
          operationId: "single-tool-takeover",
          reason: "The user finishes checkout.",
          sessionId: ${JSON.stringify(sessionId)},
        });
        await tools.agent_browser_snapshot({ sessionId: ${JSON.stringify(sessionId)} });
        return "unreachable";
      `);
      expect(takeover.status).toBe("intervention");
      expect(takeover.intervention?.reasons).toEqual(["takeover"]);
      expect(takeover.receipts).toEqual([
        {
          operation: "agent_session_takeover_request",
          operationId: "single-tool-takeover",
          outcome: "succeeded",
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.timeout(HANG_GUARD_MS),
      Effect.provide(NodeServices.layer)
    ),
  HANG_GUARD_MS
);
