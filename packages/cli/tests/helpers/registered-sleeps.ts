import { Clock, Duration, Effect, Fiber, Queue, References } from "effect";
import { TestClock } from "effect/testing";

/** Observe each registered sleep without adding a production watch signal. */
export const registeredSleeps = Effect.gen(function* observeRegisteredSleeps() {
  const clock = yield* TestClock.testClockWith(Effect.succeed);
  const sleeps = yield* Queue.unbounded<number>();
  const observedClock: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.gen(function* registerSleep() {
        // Immediate execution without scheduler yields reaches TestClock sleep registration before publishing.
        const fiber = yield* clock
          .sleep(duration)
          .pipe(
            Effect.forkChild({ startImmediately: true }),
            Effect.provideService(References.PreventSchedulerYield, true)
          );
        yield* Queue.offer(sleeps, Duration.toMillis(duration));
        yield* Fiber.join(fiber);
      }),
  };
  const waitForSleep = (millis: number) =>
    TestClock.withLive(
      Effect.gen(function* awaitRegisteredSleep() {
        while ((yield* Queue.take(sleeps)) !== millis) {
          // Read caps and inter-poll sleeps share the clock; consume only the requested event.
        }
      }).pipe(Effect.timeout("30 seconds"))
    );
  return {
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Clock.Clock, observedClock),
    waitForSleep,
  };
});
