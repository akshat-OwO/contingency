import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import {
  cleanupRecorderContexts,
  decodeNavigationEvent,
  makeCdpConnection,
  selectRecorderTarget,
} from "../../src/services/cdp-recorder";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

it.effect("resolves an agent-browser tab alias to the focused CDP page", () =>
  selectRecorderTarget(
    [
      {
        targetId: "1372BD1461BDFE711E1F3C6D24FB3A1E",
        type: "page",
        url: "https://example.com/",
      },
      {
        targetId: "9A491CFAB5BCDD689B17A50B060E838B",
        type: "page",
        url: "chrome://newtab/",
      },
    ],
    "t1",
    (targetId) =>
      Effect.succeed(targetId === "1372BD1461BDFE711E1F3C6D24FB3A1E")
  ).pipe(
    Effect.tap((targetId) =>
      Effect.sync(() => {
        expect(targetId).toBe("1372BD1461BDFE711E1F3C6D24FB3A1E");
      })
    )
  )
);

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

it("bounds page-controlled navigation data", () => {
  expect(
    decodeNavigationEvent({
      title: "Account",
      url: "https://example.com/account",
    })
  ).toEqual({
    title: "Account",
    type: "navigation",
    url: "https://example.com/account",
  });
  expect(
    decodeNavigationEvent({
      title: "Account",
      url: `https://example.com/${"a".repeat(3000)}`,
    })
  ).toBeUndefined();
  expect(
    decodeNavigationEvent({
      title: "a".repeat(3000),
      url: "https://example.com/account",
    })
  ).toBeUndefined();
});

it.effect("cleans up each recorder inside its isolated execution context", () =>
  Effect.gen(function* cleanRecorderContexts() {
    const commands: {
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>> | undefined;
      readonly sessionId: string | undefined;
    }[] = [];
    yield* cleanupRecorderContexts(
      {
        send: (method, params, sessionId) =>
          Effect.sync(() => {
            commands.push({ method, params, sessionId });
          }),
      },
      [
        { executionContextId: 12, sessionId: "page-session" },
        { executionContextId: 34, sessionId: "iframe-session" },
      ]
    );

    expect(commands).toEqual([
      {
        method: "Runtime.evaluate",
        params: {
          contextId: 12,
          expression: "globalThis.__contingencyRecorderCleanup?.()",
          returnByValue: false,
        },
        sessionId: "page-session",
      },
      {
        method: "Runtime.evaluate",
        params: {
          contextId: 34,
          expression: "globalThis.__contingencyRecorderCleanup?.()",
          returnByValue: false,
        },
        sessionId: "iframe-session",
      },
    ]);
  })
);
