import {
  AgentSessionId,
  ContingencyRpcs,
  OperationId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

/**
 * The RPC client is the public seam for MCP and Workspace adapters. The
 * browser below is real Chromium; only unrelated Recording/Run handlers are
 * supplied with services because this test exercises Agent Session ownership.
 */
const BrowserServices = makeAgentSessionLayer({
  allowedActivity: "any",
  baseUrl: "http://127.0.0.1:7777",
}).pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);
const AgentSessionIntegrationLive = RpcHandlersLive.pipe(
  Layer.provide(BrowserServices)
);

const teachingIntegrationLive = (root: string) =>
  RpcHandlersLive.pipe(
    Layer.provide(
      makeAgentSessionLayer({
        allowedActivity: "teaching",
        baseUrl: "http://127.0.0.1:7777",
        traceDirectory: () => root,
      }).pipe(
        Layer.provide(makeTeachingRecordingStoreLayer({ root: () => root })),
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
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
        `/?session=${encodeURIComponent(firstSession.id)}`
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

it.live("records only between Teaching Start and Stop RPCs", () =>
  Effect.gen(function* teachingCaptureBoundary() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-boundary-",
    });
    yield* Effect.gen(function* driveTeachingBoundary() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      const opened = yield* client("agent.session.start", {
        data: {
          activity: "teaching",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          name: "capture-boundary",
          operationId: OperationId.make("open-teaching-boundary"),
          url: "about:blank",
          viewport,
        },
        type: "agent.session.start",
      });
      const setup = opened.data.session;
      expect(setup.captureState?._tag).toBe("setup");
      const recordingDirectory = `${root}/.recordings/${setup.recordingId}`;
      expect(yield* fileSystem.readDirectory(recordingDirectory)).toEqual([
        "manifest.json",
      ]);

      const started = yield* client("agent.teaching.recording.start", {
        data: {
          operationId: OperationId.make("start-teaching-boundary"),
          sessionId: setup.id,
        },
        type: "agent.teaching.recording.start",
      });
      expect(started.data.session.captureState?._tag).toBe("recording");
      yield* client("agent.browser.navigate", {
        data: {
          action: {
            type: "navigate",
            url: "data:text/html,<title>recorded</title><main>recorded</main>",
          },
          sessionId: setup.id,
        },
        type: "agent.browser.navigate",
      });
      const stopped = yield* client("agent.teaching.recording.stop", {
        data: {
          operationId: OperationId.make("stop-teaching-boundary"),
          sessionId: setup.id,
        },
        type: "agent.teaching.recording.stop",
      });
      expect(stopped.data.session.captureState?._tag).toBe("ready");
      expect(stopped.data.session.phase).toBe("running");
      const events = yield* fileSystem.readFileString(
        `${recordingDirectory}/events.jsonl`
      );
      expect(events).toContain('"_tag":"started"');
      expect(events).toContain('"_tag":"action"');
      expect(events.trimEnd().split("\n").at(-1)).toContain('"_tag":"stopped"');
      expect(
        yield* fileSystem.exists(`${recordingDirectory}/recording.webm`)
      ).toBe(true);
      expect(yield* fileSystem.exists(`${recordingDirectory}/trace.zip`)).toBe(
        true
      );

      const second = yield* client("agent.teaching.recording.start", {
        data: {
          operationId: OperationId.make("start-second-teaching-boundary"),
          sessionId: setup.id,
        },
        type: "agent.teaching.recording.start",
      });
      expect(second.data.session.recordingId).not.toBe(setup.recordingId);
      yield* client("agent.teaching.recording.stop", {
        data: {
          operationId: OperationId.make("stop-second-teaching-boundary"),
          sessionId: setup.id,
        },
        type: "agent.teaching.recording.stop",
      });
      yield* client("agent.session.close", {
        data: {
          operationId: OperationId.make("close-teaching-boundary"),
          sessionId: setup.id,
        },
        type: "agent.session.close",
      });
    }).pipe(Effect.scoped, Effect.provide(teachingIntegrationLive(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
