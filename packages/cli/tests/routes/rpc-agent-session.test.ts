import { AgentSessionSnapshot, ContingencyRpcs } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { RpcTest } from "effect/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { AgentSession } from "../../src/services/agent-session.ts";

const snapshot = Schema.decodeUnknownSync(AgentSessionSnapshot)({
  activity: "run",
  captureState: null,
  clientName: "rpc-agent",
  clientVersion: "1.0.0",
  controller: "agent",
  createdAt: "2026-10-10T00:00:00.000Z",
  currentUrl: "about:blank",
  eventCursor: "rpc-session:0",
  flowSkillName: null,
  id: "agent-rpc",
  interruptedAction: null,
  ownerProcessId: "rpc-process",
  phase: "running",
  recordingId: null,
  run: null,
  takeover: null,
  teaching: null,
  timeline: [],
  updatedAt: "2026-10-10T00:00:00.000Z",
  viewUrl: "http://127.0.0.1:7777/?session=agent-rpc",
});

it.effect("seeds an immediate read before a concurrent session change", () =>
  Effect.gen(function* immediateSessionRead() {
    const changed = yield* Deferred.make<true>();
    const current = { ...snapshot, currentUrl: "https://shop.example.test" };
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    }).pipe(
      Effect.provide(
        RpcHandlersLive.pipe(
          Layer.provide(
            Layer.mock(AgentSession, {
              get: (sessionId) =>
                Effect.gen(function* changeDuringRead() {
                  expect(sessionId).toBe(snapshot.id);
                  yield* Deferred.succeed(changed, true);
                  return { ...current, eventCursor: undefined };
                }),
              sessionEvents: (sessionId) =>
                Effect.gen(function* readCursor() {
                  expect(sessionId).toBe(snapshot.id);
                  return {
                    eventCursor: (yield* Deferred.isDone(changed))
                      ? "rpc-session:1"
                      : "rpc-session:0",
                    events: [],
                    eventsTruncated: false,
                  };
                }),
            })
          )
        )
      )
    );
    expect(
      yield* client("agent.session.get", {
        sessionId: snapshot.id,
        waitMs: 1234,
      })
    ).toEqual({ session: current });
  }).pipe(Effect.scoped)
);

it.live("keeps the RPC pending until the session event wait answers", () =>
  Effect.gen(function* longPollSessionRead() {
    const entered = yield* Deferred.make<{
      readonly afterCursor: string;
      readonly sessionId: string;
      readonly waitMs: number | undefined;
    }>();
    const event = yield* Deferred.make<AgentSessionSnapshot>();
    const answered = yield* Deferred.make<true>();
    const client = yield* RpcTest.makeClient(ContingencyRpcs, {
      flatten: true,
    }).pipe(
      Effect.provide(
        RpcHandlersLive.pipe(
          Layer.provide(
            Layer.mock(AgentSession, {
              get: () => Effect.succeed(snapshot),
              waitForEvents: (sessionId, afterCursor, waitMs) =>
                Effect.gen(function* awaitEvent() {
                  yield* Deferred.succeed(entered, {
                    afterCursor,
                    sessionId,
                    waitMs,
                  });
                  const session = yield* Deferred.await(event);
                  return { ...session, events: [], eventsTruncated: false };
                }),
            })
          )
        )
      )
    );
    const pending = yield* client("agent.session.get", {
      afterCursor: snapshot.eventCursor,
      sessionId: snapshot.id,
      waitMs: 1234,
    }).pipe(
      Effect.tap(() => Deferred.succeed(answered, true)),
      Effect.timeout("30 seconds"),
      Effect.forkChild
    );
    expect(
      yield* Deferred.await(entered).pipe(Effect.timeout("30 seconds"))
    ).toEqual({
      afterCursor: snapshot.eventCursor,
      sessionId: snapshot.id,
      waitMs: 1234,
    });
    expect(yield* Deferred.isDone(answered)).toBe(false);
    const changed = { ...snapshot, eventCursor: "rpc-session:1" };
    yield* Deferred.succeed(event, changed);
    expect((yield* Fiber.join(pending)).session).toMatchObject(changed);
  }).pipe(Effect.scoped)
);

it.effect("forwards zero and omitted waitMs to the cursor read", () =>
  Effect.gen(function* cursorReadOptions() {
    for (const waitMs of [0, undefined]) {
      const client = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      }).pipe(
        Effect.provide(
          RpcHandlersLive.pipe(
            Layer.provide(
              Layer.mock(AgentSession, {
                waitForEvents: (sessionId, afterCursor, actualWaitMs) => {
                  expect(sessionId).toBe(snapshot.id);
                  expect(afterCursor).toBe(snapshot.eventCursor);
                  expect(actualWaitMs).toBe(waitMs);
                  return Effect.succeed({
                    ...snapshot,
                    events: [],
                    eventsTruncated: false,
                  });
                },
              })
            )
          )
        )
      );
      expect(
        (yield* client("agent.session.get", {
          afterCursor: snapshot.eventCursor,
          sessionId: snapshot.id,
          waitMs,
        })).session
      ).toMatchObject(snapshot);
    }
  }).pipe(Effect.scoped)
);
