import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";

import { makeOperationLedger } from "../../src/services/operation-ledger.ts";
import type {
  OperationCodec,
  OperationRequest,
} from "../../src/services/operation-ledger.ts";

type Kind = "rename" | "act";
type Outcome =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "failure"; readonly error: string };

interface Conflict {
  readonly _tag: "Conflict";
  readonly message: string;
}

const makeLedger = () =>
  makeOperationLedger<Kind, Outcome, Conflict>((operationId, bound) => ({
    _tag: "Conflict",
    message: `Operation ${operationId} was already used for a different ${bound.kind} request.`,
  }));

const request = (
  input: string,
  operationId: string | undefined = "op-1",
  kind: Kind = "rename"
): OperationRequest<Kind> => ({
  input,
  kind,
  operationId,
  target: "session-1",
});

/** Keeps a success; keeps a failure only when it says it was dispatched. */
const codec: OperationCodec<string, string, Outcome, Conflict> = {
  keep: (result) => {
    if (Result.isSuccess(result)) {
      return { kind: "value", value: result.success };
    }
    return result.failure.startsWith("dispatched")
      ? { error: result.failure, kind: "failure" }
      : undefined;
  },
  replay: (outcome) =>
    outcome.kind === "value"
      ? Effect.succeed(outcome.value)
      : Effect.fail(outcome.error),
};

const counted = <A, E>(effect: Effect.Effect<A, E>) => {
  const counter = { runs: 0 };
  const attempt = Effect.suspend(() => {
    counter.runs += 1;
    return effect;
  });
  return { attempt, counter };
};

it.effect("an identical request replays the kept outcome", () =>
  Effect.gen(function* replayKeptOutcome() {
    const ledger = makeLedger();
    const { attempt, counter } = counted(Effect.succeed("renamed"));
    const first = yield* ledger.run(request("a"), attempt, codec);
    const second = yield* ledger.run(request("a"), attempt, codec);
    expect([first, second]).toEqual(["renamed", "renamed"]);
    expect(counter.runs).toBe(1);
  })
);

it.effect("a request without an operation id runs every time", () =>
  Effect.gen(function* runWithoutId() {
    const ledger = makeLedger();
    const { attempt, counter } = counted(Effect.succeed("ran"));
    const anonymous = { ...request("a"), operationId: undefined };
    yield* ledger.run(anonymous, attempt, codec);
    yield* ledger.run(anonymous, attempt, codec);
    expect(counter.runs).toBe(2);
  })
);

it.effect("a different request under a kept id is refused", () =>
  Effect.gen(function* refuseConflict() {
    const ledger = makeLedger();
    const { attempt, counter } = counted(Effect.succeed("renamed"));
    yield* ledger.run(request("a"), attempt, codec);
    const differentInput = yield* Effect.flip(
      ledger.run(request("b"), attempt, codec)
    );
    const differentKind = yield* Effect.flip(
      ledger.run(request("a", "op-1", "act"), attempt, codec)
    );
    expect(differentInput).toEqual({
      _tag: "Conflict",
      message:
        "Operation op-1 was already used for a different rename request.",
    });
    expect(differentKind).toEqual(differentInput);
    expect(counter.runs).toBe(1);
  })
);

it.effect("concurrent identical requests run once and share the outcome", () =>
  Effect.gen(function* serializeSameId() {
    const ledger = makeLedger();
    const release = yield* Deferred.make<true>();
    const started = yield* Deferred.make<true>();
    const { attempt, counter } = counted(
      Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("renamed")
      )
    );
    const first = yield* Effect.forkChild(
      ledger.run(request("a"), attempt, codec)
    );
    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(
      ledger.run(request("a"), attempt, codec)
    );
    // A different request is refused while the first is still in flight.
    const conflict = yield* Effect.flip(
      ledger.run(request("b"), attempt, codec)
    );
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(first)).toBe("renamed");
    expect(yield* Fiber.join(second)).toBe("renamed");
    expect(conflict).toMatchObject({ _tag: "Conflict" });
    expect(counter.runs).toBe(1);
  })
);

it.effect("a kept failure replays instead of running again", () =>
  Effect.gen(function* replayKeptFailure() {
    const ledger = makeLedger();
    const { attempt, counter } = counted(Effect.fail("dispatched: timed out"));
    const first = yield* Effect.flip(ledger.run(request("a"), attempt, codec));
    const second = yield* Effect.flip(ledger.run(request("a"), attempt, codec));
    expect([first, second]).toEqual([
      "dispatched: timed out",
      "dispatched: timed out",
    ]);
    expect(counter.runs).toBe(1);
  })
);

it.effect("a failure that keeps nothing frees the id for a retry", () =>
  Effect.gen(function* retryUnkeptFailure() {
    const ledger = makeLedger();
    const refused = counted(Effect.fail("refused before dispatch"));
    yield* Effect.flip(ledger.run(request("a"), refused.attempt, codec));
    yield* Effect.flip(ledger.run(request("a"), refused.attempt, codec));
    expect(refused.counter.runs).toBe(2);
    // Nothing took effect, so the id is not bound to the refused request.
    const retried = yield* ledger.run(
      request("b"),
      Effect.succeed("renamed"),
      codec
    );
    expect(retried).toBe("renamed");
  })
);

it.effect("a waiter runs the attempt itself when the first keeps nothing", () =>
  Effect.gen(function* waiterRetries() {
    const ledger = makeLedger();
    const release = yield* Deferred.make<true>();
    const started = yield* Deferred.make<true>();
    let runs = 0;
    const attempt: Effect.Effect<string, string> = Effect.suspend(() => {
      runs += 1;
      return runs === 1
        ? Deferred.succeed(started, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail("refused before dispatch"))
          )
        : Effect.succeed("renamed");
    });
    const first = yield* Effect.forkChild(
      ledger.run(request("a"), attempt, codec)
    );
    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(
      ledger.run(request("a"), attempt, codec)
    );
    yield* Deferred.succeed(release, true);
    expect(yield* Effect.flip(Fiber.join(first))).toBe(
      "refused before dispatch"
    );
    expect(yield* Fiber.join(second)).toBe("renamed");
    expect(runs).toBe(2);
  })
);

it.effect("an interrupted attempt keeps nothing and can be retried", () =>
  Effect.gen(function* retryInterrupted() {
    const ledger = makeLedger();
    const started = yield* Deferred.make<true>();
    const interrupted = yield* Effect.forkChild(
      ledger.run(
        request("a"),
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.as("never")
        ),
        codec
      )
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(interrupted);
    const retried = yield* ledger.run(
      request("b"),
      Effect.succeed("renamed"),
      codec
    );
    const replayed = yield* ledger.run(
      request("b"),
      Effect.succeed("again"),
      codec
    );
    expect([retried, replayed]).toEqual(["renamed", "renamed"]);
  })
);
