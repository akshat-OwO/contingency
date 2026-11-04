import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { Effect, Queue } from "effect";

/** Viewer state is replaceable. Reliable Session Events live in their own log. */
export const makeSessionStateChanges = () => {
  const subscribers = new Map<
    AgentSessionId,
    Set<Queue.Queue<AgentSessionSnapshot>>
  >();
  return {
    publish: (snapshot: AgentSessionSnapshot) =>
      Effect.sync(() => {
        for (const queue of subscribers.get(snapshot.id) ?? []) {
          // Queue.offerUnsafe honors sliding; PubSub.publishUnsafe does not.
          Queue.offerUnsafe(queue, snapshot);
        }
      }),
    subscribe: (sessionId: AgentSessionId) =>
      Effect.acquireRelease(
        Effect.gen(function* subscribeToLatestState() {
          const queue = yield* Queue.sliding<AgentSessionSnapshot>(1);
          const selected = subscribers.get(sessionId) ?? new Set();
          selected.add(queue);
          subscribers.set(sessionId, selected);
          return queue;
        }),
        (queue) =>
          Effect.sync(() => {
            const selected = subscribers.get(sessionId);
            selected?.delete(queue);
            if (selected?.size === 0) {
              subscribers.delete(sessionId);
            }
            Queue.shutdownUnsafe(queue);
          })
      ),
  };
};
