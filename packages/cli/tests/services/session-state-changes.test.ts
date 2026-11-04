import { AgentSessionId, AgentSessionSnapshot } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Queue, Schema, Scope, Exit } from "effect";

import { makeSessionStateChanges } from "../../src/services/session-state-changes.ts";

const snapshot = Schema.decodeUnknownSync(AgentSessionSnapshot)({
  activity: "run",
  boundary: null,
  captureState: null,
  clientName: "test",
  clientVersion: "1",
  controller: "agent",
  createdAt: "2026-11-04T00:00:00Z",
  currentUrl: "about:blank",
  dryRun: null,
  flowName: null,
  id: "agent-state",
  interruptedAction: null,
  ownerProcessId: "test",
  phase: "running",
  recordingId: null,
  run: null,
  takeover: null,
  teaching: null,
  timeline: [],
  updatedAt: "2026-11-04T00:00:00Z",
  viewUrl: "http://localhost/",
});

it.effect(
  "bounds stalled subscribers independently and releases closed subscriptions",
  () =>
    Effect.gen(function* stalledViewers() {
      const changes = makeSessionStateChanges();
      const scope = yield* Scope.make();
      const first = yield* changes
        .subscribe(snapshot.id)
        .pipe(Scope.provide(scope));
      const second = yield* changes.subscribe(snapshot.id);
      const otherId = AgentSessionId.make("agent-other");
      const other = yield* changes.subscribe(otherId);
      for (let index = 0; index < 10_000; index += 1) {
        yield* changes.publish({
          ...snapshot,
          currentUrl: `https://example.test/${index}`,
        });
      }
      expect(yield* Queue.size(first)).toBe(1);
      expect(yield* Queue.size(second)).toBe(1);
      expect(yield* Queue.size(other)).toBe(0);
      expect((yield* Queue.take(first)).currentUrl).toBe(
        "https://example.test/9999"
      );
      expect((yield* Queue.take(second)).currentUrl).toBe(
        "https://example.test/9999"
      );
      yield* Scope.close(scope, Exit.void);
      yield* changes.publish({ ...snapshot, phase: "closed" });
      expect((yield* Queue.take(second)).phase).toBe("closed");
      expect(Queue.offerUnsafe(first, snapshot)).toBe(false);
    }).pipe(Effect.scoped)
);
