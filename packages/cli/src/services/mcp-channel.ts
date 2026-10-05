import {
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Sink,
  Stdio,
  Stream,
  Predicate,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AgentSessionService } from "./agent-session.ts";
import { AgentSession } from "./agent-session.ts";
import type { SessionEventBatch } from "./session-events.ts";

const InitializeResponse = Schema.Struct({
  result: Schema.Struct({
    capabilities: Schema.JsonObject,
    protocolVersion: Schema.Literals(["2025-06-18", "2025-11-25"]),
  }),
});
const decodeInitialize = Schema.decodeUnknownOption(InitializeResponse);
const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.JsonObject)
);
const decodeObject = Schema.decodeUnknownOption(Schema.JsonObject);

/** Summaries deliberately never copy event names, snapshots, or Variable values. */
export const channelFrames = (batches: readonly SessionEventBatch[]) => {
  const sessions = new Map<string, { cursor: string; kinds: Set<string> }>();
  for (const batch of batches) {
    const pending = sessions.get(batch.sessionId) ?? {
      cursor: batch.eventCursor,
      kinds: new Set<string>(),
    };
    for (const event of batch.events) {
      pending.kinds.add(event.kind);
    }
    sessions.set(batch.sessionId, pending);
  }
  return [...sessions].map(([sessionId, { cursor, kinds }]) => ({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      content: `Session ${sessionId}: ${[...kinds].join(", ")}`,
      meta: { eventCursor: cursor, sessionId },
    },
  }));
};

/**
 * Effect 4's McpServer has no custom notification or experimental capability
 * API. Extend its public Stdio boundary, retaining its negotiation, framing,
 * cancellation, and tool codecs. Both writers share one ordered output queue.
 * This layer is installed only on the opted-in stdio adapter, never HTTP.
 */
export const makeChannelStdio = (
  session: Pick<AgentSessionService, "sessionEventChanges" | "list">
) =>
  Effect.gen(function* makeChannelTransport() {
    const stdio = yield* Stdio.Stdio;
    const output = yield* Queue.unbounded<string | Uint8Array>();
    const registry = AtomRegistry.make();
    const connected = Atom.make(false).pipe(Atom.keepAlive);
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    yield* Stream.fromQueue(output).pipe(
      Stream.run(stdio.stdout()),
      Effect.orDie,
      Effect.forkScoped
    );
    const waiting = Atom.make<ReadonlyMap<string, SessionEventBatch>>(
      new Map()
    ).pipe(Atom.keepAlive);
    yield* session.sessionEventChanges.pipe(
      Stream.filter(() => registry.get(connected)),
      Stream.groupByKey((batch) => batch.sessionId, {
        idleTimeToLive: "1 minute",
      }),
      Stream.mapEffect(
        ([sessionId, changes]) =>
          changes.pipe(
            Stream.tap((batch) =>
              Effect.sync(() => {
                const next = new Map(registry.get(waiting));
                const previous = next.get(batch.sessionId);
                const events = new Map(
                  previous?.events.map((event) => [event.kind, event])
                );
                for (const event of batch.events) {
                  events.set(event.kind, event);
                }
                next.set(batch.sessionId, {
                  eventCursor: previous?.eventCursor ?? batch.eventCursor,
                  events: [...events.values()],
                  sessionId: batch.sessionId,
                });
                registry.set(waiting, next);
              })
            ),
            Stream.debounce("250 millis"),
            Stream.runForEach(() =>
              Effect.gen(function* sendChannelBatch() {
                const batches = new Map(registry.get(waiting));
                const batch = batches.get(sessionId);
                batches.delete(sessionId);
                registry.set(waiting, batches);
                yield* Effect.forEach(
                  channelFrames(batch === undefined ? [] : [batch]),
                  (frame) => Queue.offer(output, `${JSON.stringify(frame)}\n`)
                );
              })
            )
          ),
        { concurrency: "unbounded" }
      ),
      Stream.runDrain,
      Effect.forkScoped
    );
    // Refresh durable Teaching changes from other processes at the same
    // cadence as agent_session_get's wait path, including Workspace Verify.
    yield* Effect.forever(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(() =>
          registry.get(connected) ? session.list() : Effect.succeed([])
        )
      )
    ).pipe(Effect.forkScoped);
    const decoder = new TextDecoder();
    let pending = "";
    return Stdio.make({
      ...stdio,
      stdout: () =>
        // oxlint-disable-next-line unicorn/no-array-for-each -- Effect Sink, not Array iteration.
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.gen(function* forwardMcpFrames() {
            pending += Predicate.isString(chunk)
              ? chunk
              : decoder.decode(chunk, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              const frame = decodeFrame(line);
              const result = frame.pipe(
                Option.flatMap((message) => decodeObject(message.result))
              );
              const initialize = frame.pipe(Option.flatMap(decodeInitialize));
              if (
                Option.isSome(frame) &&
                Option.isSome(result) &&
                Option.isSome(initialize)
              ) {
                yield* Queue.offer(
                  output,
                  `${JSON.stringify({
                    ...frame.value,
                    result: {
                      ...result.value,
                      capabilities: {
                        ...initialize.value.result.capabilities,
                        experimental: { "claude/channel": {} },
                      },
                    },
                  })}\n`
                );
                registry.set(connected, true);
              } else {
                yield* Queue.offer(output, `${line}\n`);
              }
              newline = pending.indexOf("\n");
            }
          })
        ),
    });
  });

export const McpChannelStdio = Layer.effect(
  Stdio.Stdio,
  Effect.gen(function* channelLayer() {
    return yield* makeChannelStdio(yield* AgentSession);
  })
);
