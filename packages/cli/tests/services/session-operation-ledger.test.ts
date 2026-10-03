import {
  AgentSessionSnapshot,
  makeBrowserRpcError,
} from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";

import { makeSessionOperationLedger } from "../../src/services/session-operation-ledger.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const snapshot = Schema.decodeUnknownSync(AgentSessionSnapshot)({
  activity: "run",
  boundary: null,
  captureState: null,
  clientName: "test",
  clientVersion: "1",
  controller: "agent",
  createdAt: "2026-10-03T00:00:00Z",
  currentUrl: "about:blank",
  dryRun: null,
  flowSkillName: null,
  id: "agent-ledger",
  interruptedAction: null,
  ownerProcessId: "ledger-test",
  phase: "running",
  recordingId: null,
  run: null,
  takeover: null,
  teaching: null,
  timeline: [],
  updatedAt: "2026-10-03T00:00:00Z",
  viewUrl: "http://localhost/",
});

it.effect(
  "concurrent identical session requests commit once and replay the same object",
  () =>
    Effect.gen(function* concurrentSessionRetries() {
      const ledger = makeSessionOperationLedger();
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      let calls = 0;
      const operation = ledger.session(
        "start",
        "start",
        "start",
        "prepared request",
        Effect.gen(function* operation() {
          calls += 1;
          yield* Deferred.succeed(entered, true);
          yield* Deferred.await(release);
          yield* ledger.rememberSession(
            "start",
            "start",
            "start",
            "prepared request",
            snapshot
          );
          return snapshot;
        })
      );
      const first = yield* Effect.forkChild(operation);
      yield* Deferred.await(entered);
      const retry = yield* Effect.forkChild(operation);
      yield* Effect.yieldNow;
      expect(calls).toBe(1);
      yield* Deferred.succeed(release, true);
      expect(yield* Fiber.join(first)).toBe(snapshot);
      expect(yield* Fiber.join(retry)).toBe(snapshot);
      expect(calls).toBe(1);
    })
);

it.effect(
  "conflicting payloads, targets, and kinds cannot overwrite a receipt",
  () =>
    Effect.gen(function* conflictingRequests() {
      const ledger = makeSessionOperationLedger();
      yield* ledger.session(
        "id",
        "control",
        "session",
        "original",
        ledger
          .rememberSession("id", "control", "session", "original", snapshot)
          .pipe(Effect.as(snapshot))
      );
      for (const [kind, target, input] of [
        ["control", "session", "changed"],
        ["control", "other", "original"],
        ["close", "session", "original"],
      ] as const) {
        const failure = yield* Effect.flip(
          ledger.session(
            "id",
            kind,
            target,
            input,
            Effect.die("A conflicting request must not execute.")
          )
        );
        expect(failure.message).toBe(
          "Operation id was already used for a different control request."
        );
        expect(failure.code).toBe("agent_session_conflict");
      }
      expect(
        yield* ledger.session(
          "id",
          "control",
          "session",
          "original",
          Effect.die("Must replay.")
        )
      ).toBe(snapshot);
    })
);

it.effect(
  "an interrupted mutation releases its gate without recording success",
  () =>
    Effect.gen(function* interruptedMutation() {
      const ledger = makeSessionOperationLedger();
      const entered = yield* Deferred.make<true>();
      const first = yield* Effect.forkChild(
        ledger.session(
          "id",
          "start",
          "start",
          "request",
          Effect.gen(function* first() {
            yield* Deferred.succeed(entered, true);
            yield* Effect.never;
            yield* ledger.rememberSession(
              "id",
              "start",
              "start",
              "request",
              snapshot
            );
            return snapshot;
          })
        )
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      let retried = false;
      const result = yield* ledger.session(
        "id",
        "start",
        "start",
        "request",
        Effect.gen(function* result() {
          retried = true;
          yield* ledger.rememberSession(
            "id",
            "start",
            "start",
            "request",
            snapshot
          );
          return snapshot;
        })
      );
      expect(retried).toBe(true);
      expect(result).toBe(snapshot);
    })
);

it.effect(
  "a committed mutation remains replayable when its response is interrupted",
  () =>
    Effect.gen(function* interruptedResponse() {
      const ledger = makeSessionOperationLedger();
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const first = yield* Effect.forkChild(
        ledger.session(
          "id",
          "close",
          "session",
          "",
          Effect.uninterruptible(
            Effect.gen(function* first() {
              yield* Deferred.succeed(entered, true);
              yield* Deferred.await(release);
              yield* ledger.rememberSession(
                "id",
                "close",
                "session",
                "",
                snapshot
              );
              return snapshot;
            })
          )
        )
      );
      yield* Deferred.await(entered);
      first.interruptUnsafe();
      yield* Deferred.succeed(release, true);
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      expect(
        yield* ledger.session(
          "id",
          "close",
          "session",
          "",
          Effect.die("Must replay.")
        )
      ).toBe(snapshot);
    })
);

it.effect(
  "concurrent failed action retries dispatch once and retain action identity",
  () =>
    Effect.gen(function* concurrentActionRetries() {
      const ledger = makeSessionOperationLedger();
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const failure = makeBrowserRpcError(
        "agent_browser_failed",
        "Dispatched action failed."
      );
      let dispatches = 0;
      const action = ledger.action(
        "id",
        "act",
        "session",
        "reload",
        Effect.gen(function* action() {
          dispatches += 1;
          yield* Deferred.succeed(entered, true);
          yield* Deferred.await(release);
          yield* ledger.remember("id", "act", "session", "reload", {
            error: failure,
            kind: "act-failure",
          });
          return yield* Effect.fail(failure);
        })
      );
      const first = yield* Effect.forkChild(Effect.flip(action));
      yield* Deferred.await(entered);
      const retry = yield* Effect.forkChild(Effect.flip(action));
      const conflict = yield* Effect.flip(
        ledger.action(
          "id",
          "act",
          "session",
          "navigate",
          Effect.die("Must not dispatch.")
        )
      );
      expect(conflict.message).toBe(
        "This operation id is already bound to a different action attempt."
      );
      yield* Deferred.succeed(release, true);
      expect(yield* Fiber.join(first)).toBe(failure);
      expect(yield* Fiber.join(retry)).toBe(failure);
      expect(dispatches).toBe(1);
    })
);

it.effect(
  "an action and a summary sharing an id serialize before checking identity",
  () =>
    Effect.gen(function* crossFamilyConflict() {
      const ledger = makeSessionOperationLedger();
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const first = yield* Effect.forkChild(
        ledger.summary(
          "id",
          "session",
          "account",
          Effect.gen(function* first() {
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
            yield* ledger.rememberRunSummary(
              "id",
              "session",
              "account",
              taskRunSummary
            );
            return taskRunSummary;
          })
        )
      );
      yield* Deferred.await(entered);
      const action = yield* Effect.forkChild(
        Effect.flip(
          ledger.action(
            "id",
            "act",
            "session",
            "reload",
            Effect.die("Must not dispatch.")
          )
        )
      );
      yield* Deferred.succeed(release, true);
      expect(yield* Fiber.join(first)).toBe(taskRunSummary);
      expect((yield* Fiber.join(action)).message).toBe(
        "Operation id was already used for a different complete request."
      );
      expect(
        yield* ledger.summary(
          "id",
          "session",
          "account",
          Effect.die("Must replay.")
        )
      ).toBe(taskRunSummary);
    })
);

it.effect("requests without an operation id execute independently", () =>
  Effect.gen(function* unidentifiedRequests() {
    const ledger = makeSessionOperationLedger();
    let calls = 0;
    const operation = ledger.session(
      undefined,
      "start",
      "start",
      "",
      Effect.sync(() => {
        calls += 1;
        return snapshot;
      })
    );
    yield* operation;
    yield* operation;
    expect(calls).toBe(2);
  })
);

it.effect(
  "Workspace private input keeps its original conflict and failure replay",
  () =>
    Effect.gen(function* workspacePrivateReplay() {
      const ledger = makeSessionOperationLedger();
      const failure = makeBrowserRpcError(
        "agent_browser_failed",
        "Private input failed."
      );
      const first = yield* Effect.flip(
        ledger.userAction(
          "private",
          "session",
          "digest",
          ledger
            .remember("private", "private-input", "session", "digest", {
              error: failure,
              kind: "act-failure",
            })
            .pipe(Effect.andThen(Effect.fail(failure)))
        )
      );
      expect(first).toBe(failure);
      expect(
        yield* Effect.flip(
          ledger.userAction(
            "private",
            "session",
            "digest",
            Effect.die("Must replay.")
          )
        )
      ).toBe(failure);
      const conflict = yield* Effect.flip(
        ledger.userAction(
          "private",
          "session",
          "changed digest",
          Effect.die("Must not execute.")
        )
      );
      expect(conflict.message).toBe(
        "Operation private was already used for a different private-input request."
      );
    })
);

it.effect("constructing an unused action does not bind its operation id", () =>
  Effect.gen(function* lazyActionBinding() {
    const ledger = makeSessionOperationLedger();
    ledger.action(
      "id",
      "act",
      "session",
      "unused request",
      Effect.die("Must not execute.")
    );
    const failure = makeBrowserRpcError(
      "agent_browser_failed",
      "Executed the requested attempt."
    );
    const actual = yield* Effect.flip(
      ledger.action(
        "id",
        "act",
        "session",
        "real request",
        Effect.fail(failure)
      )
    );
    expect(actual).toBe(failure);
  })
);
