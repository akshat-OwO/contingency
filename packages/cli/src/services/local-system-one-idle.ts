import { Clock, Duration, Effect, Queue, Ref } from "effect";

export const LOCAL_SYSTEM_ONE_IDLE_MS = 15 * 60 * 1000;

/** The same clock governs requests and the timeout, including under TestClock. */
export const makeLocalSystemOneIdle = Effect.gen(function* makeIdle() {
  const clock = yield* Clock.Clock;
  const activity = yield* Ref.make({
    inFlight: 0,
    lastActivity: yield* clock.currentTimeMillis,
  });
  const changed = yield* Queue.sliding<boolean>(1);
  const update = (delta: number) =>
    Effect.gen(function* requestActivity() {
      const now = yield* clock.currentTimeMillis;
      yield* Ref.update(activity, (state) => ({
        inFlight: state.inFlight + delta,
        lastActivity: now,
      }));
      yield* Queue.offer(changed, true);
    });
  const awaitIdle = Effect.gen(function* waitForIdle() {
    while (true) {
      const state = yield* Ref.get(activity);
      const remaining =
        LOCAL_SYSTEM_ONE_IDLE_MS -
        ((yield* clock.currentTimeMillis) - state.lastActivity);
      if (state.inFlight === 0 && remaining <= 0) {
        return;
      }
      yield* state.inFlight > 0
        ? Queue.take(changed)
        : Effect.raceFirst(
            clock.sleep(Duration.millis(Math.max(0, remaining))),
            Queue.take(changed)
          );
    }
  });
  return {
    awaitIdle,
    begin: update(1),
    end: update(-1),
    snapshot: Ref.get(activity),
  };
});
