import { AgentSessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Queue, Sink, Stdio, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeChannelStdio } from "../../src/services/mcp-channel.ts";
import type { SessionEventBatch } from "../../src/services/session-events.ts";

it.effect.each(["2025-06-18", "2025-11-25"])(
  "declares channels on %s, debounces per session, and preserves a replay cursor",
  (protocolVersion) =>
    Effect.gen(function* channelTransport() {
      const events = yield* Queue.unbounded<SessionEventBatch>();
      const output = yield* Queue.unbounded<string>();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stderr: () => Sink.drain,
        stdin: Stream.never,
        stdout: () =>
          // oxlint-disable-next-line unicorn/no-array-for-each -- Effect Sink, not Array iteration.
          Sink.forEach((chunk: string | Uint8Array) =>
            Queue.offer(output, String(chunk))
          ),
      });
      const channel = yield* makeChannelStdio({
        list: () => Effect.succeed([]),
        sessionEventChanges: Stream.fromQueue(events),
      }).pipe(Effect.provideService(Stdio.Stdio, stdio));
      const send = (text: string) =>
        Stream.succeed(text).pipe(Stream.run(channel.stdout()));
      const id = AgentSessionId.make("agent-channel");
      yield* Effect.yieldNow;
      yield* Queue.offer(events, {
        eventCursor: "epoch:0",
        events: [{ at: "now", cursor: "epoch:1", kind: "teaching-started" }],
        sessionId: id,
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("300 millis");
      expect(yield* Queue.size(output)).toBe(0);
      yield* send('diagnostic line\n{broken JSON\n[]\n{"result":null}\n');
      for (const line of [
        "diagnostic line\n",
        "{broken JSON\n",
        "[]\n",
        '{"result":null}\n',
      ]) {
        expect(yield* Queue.take(output)).toBe(line);
      }
      const init = JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          instructions: "preserve",
          protocolVersion,
        },
      });
      yield* send(init.slice(0, 30));
      yield* send(`${init.slice(30)}\n`);
      const initialized = JSON.parse(yield* Queue.take(output));
      expect(initialized.result.capabilities).toEqual({
        experimental: { "claude/channel": {} },
        tools: {},
      });
      expect(initialized.result.instructions).toBe("preserve");
      yield* Queue.offer(events, {
        eventCursor: "epoch:1",
        events: [
          {
            at: "now",
            cursor: "epoch:2",
            kind: "takeover-started",
            name: "SECRET_VARIABLE",
          },
        ],
        sessionId: id,
      });
      const other = AgentSessionId.make("agent-other-channel");
      yield* Queue.offer(events, {
        eventCursor: "other:0",
        events: [
          {
            at: "now",
            cursor: "other:1",
            kind: "variable-supplied",
            name: "PRIVATE_NAME",
          },
        ],
        sessionId: other,
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("200 millis");
      yield* Queue.offer(events, {
        eventCursor: "epoch:2",
        events: [{ at: "now", cursor: "epoch:3", kind: "takeover-returned" }],
        sessionId: id,
      });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      const independent = JSON.parse(yield* Queue.take(output));
      expect(independent.params).toEqual({
        content: `Session ${other}: variable-supplied`,
        meta: { eventCursor: "other:0", sessionId: other },
      });
      expect(yield* Queue.size(output)).toBe(0);
      yield* TestClock.adjust("150 millis");
      const frame = JSON.parse(yield* Queue.take(output));
      expect(frame).toEqual({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: `Session ${id}: takeover-started, takeover-returned`,
          meta: { eventCursor: "epoch:1", sessionId: id },
        },
      });
      yield* send('{"jsonrpc":"2.0","id":2,"result":{"value":true}}\n');
      expect(JSON.parse(yield* Queue.take(output))).toEqual({
        id: 2,
        jsonrpc: "2.0",
        result: { value: true },
      });
    })
);

// gate probe
