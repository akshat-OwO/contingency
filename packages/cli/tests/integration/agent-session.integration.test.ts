import {
  AgentSessionId,
  ContingencyRpcs,
  OperationId,
} from "@contingency/protocol";
import type { TeachingCaptureLimits } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schedule, Stream } from "effect";
import { RpcTest } from "effect/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import {
  AgentSession,
  makeAgentSessionLayer,
} from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { DEFAULT_TEACHING_CAPTURE_LIMITS } from "../../src/services/teaching-recorder.ts";
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

const teachingIntegrationLive = (
  root: string,
  captureLimits?: TeachingCaptureLimits
) =>
  RpcHandlersLive.pipe(
    Layer.provideMerge(
      makeAgentSessionLayer({
        allowedActivity: "teaching",
        baseUrl: "http://127.0.0.1:7777",
        captureLimits: captureLimits ?? DEFAULT_TEACHING_CAPTURE_LIMITS,
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
        activity: "run",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        name: "first",
        operationId: OperationId.make("start-first"),
        url: "data:text/html,<title>first</title><main>first</main>",
        viewport,
      });
      const second = yield* client("agent.session.start", {
        activity: "run",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        name: "second",
        operationId: OperationId.make("start-second"),
        url: "data:text/html,<title>second</title><main>second</main>",
        viewport,
      });
      const firstSession = first.session;
      const secondSession = second.session;
      expect(firstSession.id).not.toBe(secondSession.id);
      expect(firstSession.viewUrl).toContain(
        `/?session=${encodeURIComponent(firstSession.id)}`
      );

      const listed = yield* client("agent.sessions.get", {});
      expect(listed.sessions.map(({ id }) => id)).toEqual([
        firstSession.id,
        secondSession.id,
      ]);

      const frame = yield* client("agent.browser.stream.subscribe", {
        sessionId: firstSession.id,
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
        frameId: frame.seq,
        sessionId: firstSession.id,
        streamId: frame.streamId,
      });

      // The URL is a selector, not a credential: a caller must use the
      // process-owned RPC boundary to resolve the session, and unknown ids do
      // not reveal another process's browser.
      const unknown = yield* Effect.flip(
        client("agent.session.get", {
          sessionId: AgentSessionId.make("agent-unknown"),
        })
      );
      expect(unknown.code).toBe("agent_session_not_found");

      const closed = yield* client("agent.session.close", {
        operationId: OperationId.make("close-first"),
        sessionId: firstSession.id,
      });
      expect(closed.session.phase).toBe("closed");
      const replay = yield* client("agent.session.close", {
        operationId: OperationId.make("close-first"),
        sessionId: firstSession.id,
      });
      expect(replay.session).toEqual(closed.session);

      const remaining = yield* client("agent.sessions.get", {});
      expect(remaining.sessions.map(({ id }) => id)).toEqual([
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
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        name: "capture-boundary",
        operationId: OperationId.make("open-teaching-boundary"),
        url: "about:blank",
        viewport,
      });
      const setup = opened.session;
      expect(setup.captureState?._tag).toBe("setup");
      const recordingDirectory = `${root}/.recordings/${setup.recordingId}`;
      expect(yield* fileSystem.readDirectory(recordingDirectory)).toEqual([
        "manifest.json",
      ]);

      const started = yield* client("agent.teaching.recording.start", {
        operationId: OperationId.make("start-teaching-boundary"),
        sessionId: setup.id,
      });
      expect(started.session.captureState?._tag).toBe("recording");
      yield* client("agent.browser.navigate", {
        action: {
          type: "navigate",
          url: "data:text/html,<title>recorded</title><main>recorded</main>",
        },
        sessionId: setup.id,
      });
      const stopped = yield* client("agent.teaching.recording.stop", {
        operationId: OperationId.make("stop-teaching-boundary"),
        sessionId: setup.id,
      });
      expect(stopped.session.captureState?._tag).toBe("ready");
      expect(stopped.session.phase).toBe("running");
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
        operationId: OperationId.make("start-second-teaching-boundary"),
        sessionId: setup.id,
      });
      expect(second.session.recordingId).not.toBe(setup.recordingId);
      yield* client("agent.browser.navigate", {
        action: {
          type: "navigate",
          url: "data:text/html,<title>shutdown recording</title><main>Retain this recording after shutdown</main>",
        },
        sessionId: setup.id,
      });
      const sessions = yield* AgentSession;
      yield* sessions.closeAll();
      const interrupted = yield* sessions.get(setup.id);
      expect(interrupted.phase).toBe("interrupted");
      expect(interrupted.captureState?._tag).toBe("ready");
      const secondDirectory = `${root}/.recordings/${second.session.recordingId}`;
      const interruptedEvents = yield* fileSystem.readFileString(
        `${secondDirectory}/events.jsonl`
      );
      expect(interruptedEvents.trimEnd().split("\n").at(-1)).toContain(
        '"reason":"session-closed"'
      );
      const manifest: unknown = JSON.parse(
        yield* fileSystem.readFileString(`${secondDirectory}/manifest.json`)
      );
      expect(manifest).toMatchObject({ lifecycle: { _tag: "ready" } });
    }).pipe(Effect.scoped, Effect.provide(teachingIntegrationLive(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("ends the recording itself when a capture ceiling is reached", () =>
  Effect.gen(function* teachingCaptureCeiling() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-ceiling-",
    });
    yield* Effect.gen(function* driveTeachingCeiling() {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      const opened = yield* client("agent.session.start", {
        activity: "teaching",
        clientName: "integration-agent",
        clientVersion: "1.0.0",
        name: "capture-ceiling",
        operationId: OperationId.make("open-teaching-ceiling"),
        url: "about:blank",
        viewport,
      });
      const setup = opened.session;
      const recordingDirectory = `${root}/.recordings/${setup.recordingId}`;
      const started = yield* client("agent.teaching.recording.start", {
        operationId: OperationId.make("start-teaching-ceiling"),
        sessionId: setup.id,
      });
      expect(started.session.captureState?._tag).toBe("recording");

      // Two navigations clear the three-event ceiling on their own; the user
      // never presses Stop in this journey.
      for (const title of ["one", "two"]) {
        yield* client("agent.browser.navigate", {
          action: {
            type: "navigate",
            url: `data:text/html,<title>${title}</title><main>${title}</main>`,
          },
          sessionId: setup.id,
        });
      }

      const settled = yield* Effect.gen(function* awaitCeiling() {
        const current = yield* client("agent.session.get", {
          sessionId: setup.id,
        });
        return current.session;
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (session) => session.captureState?._tag !== "recording",
        }),
        Effect.timeout("30 seconds")
      );
      expect(settled.captureState?._tag).not.toBe("recording");

      const events = yield* fileSystem.readFileString(
        `${recordingDirectory}/events.jsonl`
      );
      expect(events).toContain('"reason":"limit-reached"');

      yield* client("agent.session.close", {
        operationId: OperationId.make("close-teaching-ceiling"),
        sessionId: setup.id,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        teachingIntegrationLive(root, {
          ...DEFAULT_TEACHING_CAPTURE_LIMITS,
          events: 3,
        })
      )
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
