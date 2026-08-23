import type { RecordingSnapshot } from "@contingency/protocol";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

export interface RecordingStateService {
  readonly changes: () => Stream.Stream<RecordingSnapshot>;
  readonly get: () => Effect.Effect<RecordingSnapshot | null>;
  readonly set: (snapshot: RecordingSnapshot | null) => Effect.Effect<void>;
}

export const RecordingState = Context.Service<RecordingStateService>(
  "@contingency/RecordingState"
);

export const RecordingStateLive = Layer.effect(
  RecordingState,
  Effect.gen(function* makeRecordingState() {
    const state = yield* SubscriptionRef.make<RecordingSnapshot | null>(null);
    return RecordingState.of({
      changes: () =>
        SubscriptionRef.changes(state).pipe(
          Stream.filter(
            (snapshot): snapshot is RecordingSnapshot => snapshot !== null
          )
        ),
      get: () => SubscriptionRef.get(state),
      set: (snapshot) => SubscriptionRef.set(state, snapshot),
    });
  })
);
