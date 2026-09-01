import {
  AgentSessionId,
  ContingencyRpcs,
  OperationId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

const runSession: RunSessionService = {
  answerVariable: () => Effect.die("Not under test."),
  artifactPath: () => Effect.die("Not under test."),
  changes: () => Stream.never,
  get: () => Effect.succeed(null),
  loadFlow: () => Effect.die("Not under test."),
  start: () => Effect.die("Not under test."),
};

/**
 * The RPC client is the public seam for MCP and Agent View adapters. The
 * browser below is real Chromium; only unrelated Recording/Run handlers are
 * supplied with services because this test exercises Agent Session ownership.
 */
const BrowserServices = Layer.mergeAll(
  makeAgentSessionLayer({ baseUrl: "http://127.0.0.1:7777" }),
  RecordingLive
).pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);
const AgentSessionIntegrationLive = RpcHandlersLive.pipe(
  Layer.provide(BrowserServices),
  Layer.provide(Layer.succeed(RunSession, runSession))
);

it.live(
  "starts multiple sessions, streams each browser, and releases owned browsers",
  () =>
    Effect.gen(function* agentSessionLifecycle() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      const first = yield* client("agent.session.start", {
        data: {
          activity: "run",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          name: "first",
          operationId: OperationId.make("start-first"),
          url: "data:text/html,<title>first</title><main>first</main>",
          viewport,
        },
        type: "agent.session.start",
      });
      const second = yield* client("agent.session.start", {
        data: {
          activity: "run",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          name: "second",
          operationId: OperationId.make("start-second"),
          url: "data:text/html,<title>second</title><main>second</main>",
          viewport,
        },
        type: "agent.session.start",
      });
      const firstSession = first.data.session;
      const secondSession = second.data.session;
      expect(firstSession.id).not.toBe(secondSession.id);
      expect(firstSession.viewUrl).toContain(
        `/agent?session=${encodeURIComponent(firstSession.id)}`
      );

      const listed = yield* client("agent.sessions.get", {
        data: {},
        type: "agent.sessions.get",
      });
      expect(listed.data.sessions.map(({ id }) => id)).toEqual([
        firstSession.id,
        secondSession.id,
      ]);

      const frame = yield* client("agent.browser.stream.subscribe", {
        data: { sessionId: firstSession.id },
        type: "agent.browser.stream.subscribe",
      }).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.runHead,
        Effect.flatMap((result) =>
          result._tag === "Some"
            ? Effect.succeed(result.value)
            : Effect.die("The Agent Session stream ended before a frame.")
        ),
        Effect.timeout("10 seconds")
      );
      expect(frame.data.length).toBeGreaterThan(0);

      yield* client("agent.browser.frame.ack", {
        data: {
          frameId: frame.seq,
          sessionId: firstSession.id,
          streamId: frame.streamId,
        },
        type: "agent.browser.frame.ack",
      });

      // The URL is a selector, not a credential: a caller must use the
      // process-owned RPC boundary to resolve the session, and unknown ids do
      // not reveal another process's browser.
      const unknown = yield* Effect.flip(
        client("agent.session.get", {
          data: { sessionId: AgentSessionId.make("agent-unknown") },
          type: "agent.session.get",
        })
      );
      expect(unknown.code).toBe("agent_session_not_found");

      const closed = yield* client("agent.session.close", {
        data: {
          operationId: OperationId.make("close-first"),
          sessionId: firstSession.id,
        },
        type: "agent.session.close",
      });
      expect(closed.data.session.phase).toBe("closed");
      const replay = yield* client("agent.session.close", {
        data: {
          operationId: OperationId.make("close-first"),
          sessionId: firstSession.id,
        },
        type: "agent.session.close",
      });
      expect(replay.data.session).toEqual(closed.data.session);

      const remaining = yield* client("agent.sessions.get", {
        data: {},
        type: "agent.sessions.get",
      });
      expect(remaining.data.sessions.map(({ id }) => id)).toEqual([
        secondSession.id,
      ]);
    }).pipe(Effect.scoped, Effect.provide(AgentSessionIntegrationLive))
);
