import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Schema,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import {
  MCP_HTTP_PATH,
  makeMcpHttpLayer,
} from "../../src/services/mcp-http.ts";
import { connectMcp } from "../helpers/mcp-http.ts";
import type { JsonValue } from "../helpers/mcp-http.ts";
import { agentProcessLayer } from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

// One hang guard per test, sized for a hung browser rather than the work.
const HANG_GUARD_MS = 120_000;

const Execution = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    structuredContent: Schema.Struct({
      diagnostic: Schema.optional(
        Schema.Struct({ kind: Schema.String, message: Schema.String })
      ),
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

/** A single-tool MCP server over a real Agent process, on a free port. */
const servingSingleTool = Effect.gen(function* serveSingleTool() {
  const files = yield* FileSystem.FileSystem;
  const root = yield* files.makeTempDirectoryScoped({
    prefix: "contingency-single-tool-",
  });
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
  return `http://127.0.0.1:${server.address.port}`;
});

it.live(
  "ends a program at an intervention and resumes only the exact attempt in a new one",
  () =>
    Effect.gen(function* interventionAcrossExecutions() {
      const fixture = yield* fixtureServer;
      const { request } = yield* connectMcp(yield* servingSingleTool);
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
      expect(replayed.diagnostic).toBeUndefined();
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

/**
 * A JSON-RPC client that names its own request ids, so a test can cancel one
 * request while it runs and read how that request's POST ended.
 */
const rawSession = (origin: string) =>
  Effect.gen(function* openRawSession() {
    const base = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    const post = (
      headers: Readonly<Record<string, string>>,
      body: { readonly [key: string]: JsonValue }
    ) =>
      Effect.promise(async () => {
        const response = await fetch(`${origin}${MCP_HTTP_PATH}`, {
          body: JSON.stringify(body),
          headers,
          method: "POST",
        });
        return {
          headers: response.headers,
          status: response.status,
          text: await response.text(),
        };
      });
    const initialized = yield* post(base, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "verify", version: "1.0" },
        protocolVersion: "2025-06-18",
      },
    });
    const headers = {
      ...base,
      "mcp-session-id": initialized.headers.get("mcp-session-id") ?? "",
    };
    const execute = (id: number, code: string) =>
      post(headers, {
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { code, timeoutMs: 90_000 },
          name: "agent_code_execute",
        },
      });
    const cancel = (requestId: number) =>
      post(headers, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { reason: "The user cancelled the program.", requestId },
      });
    return { cancel, execute };
  });

const answerOf = (text: string) =>
  Schema.decodeUnknownSync(Execution)(JSON.parse(text)).result
    .structuredContent;

/** One program step: click the fixture's add button under `operationId`. */
const click = (operationId: string) => `
    const page = await tools.agent_browser_snapshot({ sessionId, format: "structured" });
    const add = page.nodes.find((node) => node.role === "button" && node.name.includes("Add anvil"));
    const done = await tools.agent_browser_act({
      action: { ref: add.ref, type: "click" },
      format: "structured",
      operationId: ${JSON.stringify(operationId)},
      sessionId,
    });`;

/** Interpreter processes this test process still owns. */
const interpreterChildren = () => {
  try {
    return execFileSync("pgrep", [
      "-P",
      String(process.pid),
      "-f",
      "code-interpreter-process",
    ])
      .toString()
      .trim();
  } catch {
    return "";
  }
};

it.live(
  "stops a cancelled program, keeping effects it dispatched and replaying them by identity",
  () =>
    Effect.gen(function* cancelledProgram() {
      const fixture = yield* fixtureServer;
      const { cancel, execute } = yield* rawSession(yield* servingSingleTool);
      const started = answerOf(
        (yield* execute(
          2,
          `const run = await tools.agent_run_start({
            inputs: [],
            operationId: "cancel-start",
            referencedSkills: [],
            requestedTask: "Add an anvil to the cart",
            url: ${JSON.stringify(fixture.url("cancel-cart.html"))},
            view: "compact",
          });
          return run.id;`
        )).text
      );
      const id = Schema.decodeUnknownSync(Schema.String)(started.value);
      const sessionId = JSON.stringify(id);

      // The click's beacon is held, so the click is still settling when the
      // cancel arrives. Nothing after it may run.
      const added = yield* fixture.holdRequest("/anvil-added");
      const cancelled = yield* execute(
        3,
        `const sessionId = ${sessionId};${click("cancel-click")}
        const now = await tools.agent_session_get({ sessionId, view: "compact" });
        await tools.agent_session_get({ afterCursor: now.eventCursor, sessionId, view: "compact", waitMs: 60000 });
        {${click("after-cancel")}}
        return "unreachable";`
      ).pipe(Effect.forkChild);
      // A program that ends early would never click.
      const reached = yield* Effect.raceFirst(
        Deferred.await(added.arrived).pipe(Effect.as("clicked")),
        Fiber.join(cancelled).pipe(Effect.map(({ text }) => text))
      );
      expect(reached).toBe("clicked");
      expect(interpreterChildren()).not.toBe("");

      const cancelSent = yield* cancel(3);
      expect(cancelSent.status).toBe(202);
      const ended = yield* Fiber.join(cancelled);
      // MCP sends no result for a cancelled request.
      expect(ended.status).toBe(202);
      expect(ended.text).toBe("");
      expect(interpreterChildren()).toBe("");

      yield* Deferred.succeed(added.release, true);

      // The dispatched click was recorded, whether it finished or was cut off
      // mid-dispatch. Repeating its identity reads that record; nothing is
      // dispatched again, and the click after the cancel never ran.
      const replayed = answerOf(
        (yield* execute(
          5,
          `const sessionId = ${sessionId};
          let replay;
          try {
            ${click("cancel-click")}
            replay = { id: done.entry.id };
          } catch (error) {
            replay = { refused: error.message };
          }
          const page = await tools.agent_browser_snapshot({ sessionId, format: "structured" });
          return {
            cart: page.nodes.filter((node) => node.name.includes("Cart has")).map((node) => node.name),
            replay,
          };`
        )).text
      );
      expect(replayed.diagnostic).toBeUndefined();
      const { cart, replay } = Schema.decodeUnknownSync(
        Schema.Struct({
          cart: Schema.Array(Schema.String),
          replay: Schema.Union([
            Schema.Struct({ id: Schema.String }),
            Schema.Struct({ refused: Schema.String }),
          ]),
        })
      )(replayed.value);
      // One add: the cancelled click happened once, and the click after
      // the cancel never ran.
      expect(cart).toEqual([expect.stringContaining("Cart has 1 items")]);
      // A click cut off mid-dispatch keeps an uncertain record, which the
      // retry reads instead of clicking again; a finished one replays.
      expect("refused" in replay ? replay.refused : replay.id).toMatch(
        /dispatched but its outcome is unknown|^action-/u
      );
    }).pipe(
      Effect.scoped,
      Effect.timeout(HANG_GUARD_MS),
      Effect.provide(NodeServices.layer)
    ),
  HANG_GUARD_MS
);
