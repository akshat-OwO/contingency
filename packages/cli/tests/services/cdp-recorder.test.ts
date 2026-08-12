import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { makeCdpConnection } from "../../src/services/cdp-recorder";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

it.effect("fails an in-flight CDP command when the remote socket closes", () =>
  Effect.gen(function* closePendingCommand() {
    const socket = new FakeSocket();
    const connection = makeCdpConnection(
      socket as unknown as WebSocket,
      () => null,
      () => null
    );
    const error = yield* Effect.scoped(
      Effect.gen(function* runPendingCommand() {
        const pending = yield* Effect.forkScoped(
          connection.send("Target.getTargets")
        );
        yield* Effect.yieldNow;
        socket.close();
        return yield* Effect.flip(Fiber.join(pending));
      })
    );

    expect(error.code).toBe("recording_unavailable");
    expect(error.message).toContain("connection closed");
  })
);

it.effect("narrows malformed CDP error payloads without throwing", () =>
  Effect.gen(function* narrowResponse() {
    const socket = new FakeSocket();
    const connection = makeCdpConnection(
      socket as unknown as WebSocket,
      () => null,
      () => null
    );
    const result = yield* Effect.scoped(
      Effect.gen(function* runMalformedResponse() {
        const pending = yield* Effect.forkScoped(
          connection.send("Runtime.enable")
        );
        yield* Effect.yieldNow;
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ error: null, id: 1 }),
          })
        );
        return yield* Fiber.join(pending);
      })
    );
    expect(result).toBeUndefined();
  })
);
