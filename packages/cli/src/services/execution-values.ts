import { randomUUID } from "node:crypto";

import { Clock, Context, Effect, Layer, Option, Queue } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

/**
 * Program values too large to return inline (ADR 0059, #460). The
 * single-tool interface keeps each one here and answers with a resource link,
 * so a whole result stays reachable without filling the agent's context. The
 * store lives in memory, in the MCP process that ran the program.
 */
export const EXECUTION_VALUE_LIMITS = {
  /** How many values are kept at once; the oldest goes first. */
  entries: 32,
  /** Bytes kept at once across every value. */
  totalBytes: 32 * 1024 * 1024,
  /** How long a value can be read after its program ended. */
  ttlMs: 30 * 60_000,
} as const;

export const executionValueUri = (id: string) =>
  `contingency://executions/${id}/value`;

interface KeptValue {
  readonly bytes: number;
  readonly expiresAt: number;
  readonly text: string;
}

export interface ExecutionValueLink {
  readonly expiresAt: string;
  readonly uri: string;
}

export interface ExecutionValueStore {
  /** Retained encoded bytes and entries, without reading or pruning values. */
  readonly usage: Effect.Effect<{
    readonly entries: number;
    readonly bytes: number;
  }>;
  /** Keeps one JSON text and answers where to read it. */
  readonly keep: (text: string) => Effect.Effect<ExecutionValueLink>;
  /** The kept JSON text, unless it expired or was never kept. */
  readonly read: (id: string) => Effect.Effect<Option.Option<string>>;
}

export const ExecutionValues = Context.Service<ExecutionValueStore>(
  "@contingency/ExecutionValues"
);

const retainedBytes = (values: ReadonlyMap<string, KeptValue>): number => {
  let total = 0;
  for (const value of values.values()) {
    total += value.bytes;
  }
  return total;
};

const unexpired = (values: ReadonlyMap<string, KeptValue>, now: number) =>
  new Map([...values].filter(([, value]) => value.expiresAt > now));

export const ExecutionValuesLive = Layer.effect(
  ExecutionValues,
  Effect.gen(function* makeExecutionValues() {
    const registry = AtomRegistry.make();
    const state = Atom.make<ReadonlyMap<string, KeptValue>>(new Map()).pipe(
      Atom.keepAlive
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const changed = yield* Queue.sliding<boolean>(1);
    yield* Effect.forever(
      Effect.gen(function* expireIdleValues() {
        const now = yield* Clock.currentTimeMillis;
        registry.update(state, (current) => unexpired(current, now));
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const value of registry.get(state).values()) {
          nextExpiry = Math.min(nextExpiry, value.expiresAt);
        }
        yield* nextExpiry === Number.POSITIVE_INFINITY
          ? Queue.take(changed)
          : Effect.raceFirst(
              Queue.take(changed),
              Effect.sleep(Math.max(0, nextExpiry - now))
            );
      })
    ).pipe(Effect.forkScoped);
    return {
      keep: (text) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            const id = `exec-${randomUUID()}`;
            const kept: KeptValue = {
              bytes: Buffer.byteLength(text),
              expiresAt: now + EXECUTION_VALUE_LIMITS.ttlMs,
              text,
            };
            registry.update(state, (current) => {
              const next = unexpired(current, now);
              let total = retainedBytes(next) + kept.bytes;
              for (const [oldest, value] of next) {
                if (
                  next.size < EXECUTION_VALUE_LIMITS.entries &&
                  total <= EXECUTION_VALUE_LIMITS.totalBytes
                ) {
                  break;
                }
                next.delete(oldest);
                total -= value.bytes;
              }
              next.set(id, kept);
              return next;
            });
            return {
              expiresAt: new Date(kept.expiresAt).toISOString(),
              uri: executionValueUri(id),
            };
          }),
          Effect.tap(() => Queue.offer(changed, true))
        ),
      read: (id) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Option.fromNullishOr(registry.get(state).get(id)).pipe(
              Option.filter((value) => value.expiresAt > now),
              Option.map((value) => value.text)
            )
          )
        ),
      usage: Effect.sync(() => ({
        bytes: retainedBytes(registry.get(state)),
        entries: registry.get(state).size,
      })),
    };
  })
);
