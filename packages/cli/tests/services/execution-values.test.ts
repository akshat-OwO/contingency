import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";

import {
  EXECUTION_VALUE_LIMITS,
  ExecutionValues,
  ExecutionValuesLive,
} from "../../src/services/execution-values.ts";

const idOf = (uri: string) => uri.split("/").at(-2) ?? "";

describe("execution values", () => {
  it.effect(
    "disposes retained values and stops expiry work on scope close",
    () =>
      Effect.gen(function* teardown() {
        const clock = yield* Clock.Clock;
        const sleeping = yield* Deferred.make<null>();
        let interrupted = 0;
        const observedClock: Clock.Clock = {
          ...clock,
          sleep: (duration) =>
            Deferred.succeed(sleeping, null).pipe(
              // The captured Clock is TestClock from it.effect; scope closure
              // interrupts this pending virtual sleep without advancing time.
              // oxlint-disable-next-line contingency/no-test-wait
              Effect.andThen(clock.sleep(duration)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                })
              )
            ),
        };
        const scope = yield* Effect.acquireRelease(Scope.make(), (owned) =>
          Scope.close(owned, Exit.void)
        );
        const context = yield* Layer.buildWithScope(
          ExecutionValuesLive,
          scope
        ).pipe(Effect.provideService(Clock.Clock, observedClock));
        const values = Context.get(context, ExecutionValues);
        yield* values.keep("retained until closure");
        yield* Deferred.await(sleeping);
        expect(yield* values.usage).toEqual({ bytes: 22, entries: 1 });
        yield* Scope.close(scope, Exit.void);
        expect(interrupted).toBe(1);
        expect(Exit.isFailure(yield* Effect.exit(values.usage))).toBe(true);
        yield* TestClock.adjust(EXECUTION_VALUE_LIMITS.ttlMs);
        expect(interrupted).toBe(1);
      }).pipe(Effect.scoped)
  );

  it.effect("reads a kept value until it expires", () =>
    Effect.gen(function* expiry() {
      const values = yield* ExecutionValues;
      const link = yield* values.keep('{"rows":[1,2,3]}');
      expect(link.uri).toMatch(/^contingency:\/\/executions\/exec-.+\/value$/u);
      expect(yield* values.read(idOf(link.uri))).toEqual(
        Option.some('{"rows":[1,2,3]}')
      );
      yield* TestClock.adjust(EXECUTION_VALUE_LIMITS.ttlMs);
      expect(yield* values.read(idOf(link.uri))).toEqual(Option.none());
    }).pipe(Effect.provide(ExecutionValuesLive))
  );

  it.effect(
    "reclaims idle values at their individual expiry without a read or write",
    () =>
      Effect.gen(function* idleExpiry() {
        const values = yield* ExecutionValues;
        yield* values.keep("first");
        yield* TestClock.adjust("10 minutes");
        yield* values.keep("second");
        expect(yield* values.usage).toEqual({ bytes: 11, entries: 2 });
        yield* TestClock.adjust("20 minutes");
        expect(yield* values.usage).toEqual({ bytes: 6, entries: 1 });
        yield* TestClock.adjust("10 minutes");
        expect(yield* values.usage).toEqual({ bytes: 0, entries: 0 });
      }).pipe(Effect.provide(ExecutionValuesLive))
  );

  it.effect("lets the oldest value go when the store is full", () =>
    Effect.gen(function* eviction() {
      const values = yield* ExecutionValues;
      const links = yield* Effect.forEach(
        Array.from({ length: EXECUTION_VALUE_LIMITS.entries + 1 }, (_, index) =>
          String(index)
        ),
        (text) => values.keep(text)
      );
      const [oldest, second] = links;
      expect(yield* values.read(idOf(oldest?.uri ?? ""))).toEqual(
        Option.none()
      );
      expect(yield* values.read(idOf(second?.uri ?? ""))).toEqual(
        Option.some("1")
      );
      expect(yield* values.read(idOf(links.at(-1)?.uri ?? ""))).toEqual(
        Option.some(String(EXECUTION_VALUE_LIMITS.entries))
      );
    }).pipe(Effect.provide(ExecutionValuesLive))
  );
});
