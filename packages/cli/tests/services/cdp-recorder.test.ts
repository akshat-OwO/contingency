import { BrowserTabId, SessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Latch, Schema } from "effect";

import {
  cleanupRecorderContexts,
  decodeNavigationEvent,
  isUnsupportedRecordingTarget,
  makeCdpConnection,
  makeOrderedRecorderEventHandler,
  selectRecorderTarget,
} from "../../src/services/cdp-recorder";
import type {
  RecorderCapture,
  RecorderCaptureStartOptions,
} from "../../src/services/recording";
import { makeRecordingService } from "../../src/services/recording";

const sessionId = Schema.decodeUnknownSync(SessionId)("create-ordering");
const tabId = Schema.decodeUnknownSync(BrowserTabId)("tab-ordering");

const makeCapture = (): {
  readonly capture: RecorderCapture;
  readonly options: () => RecorderCaptureStartOptions;
} => {
  let activeOptions: RecorderCaptureStartOptions | undefined;
  return {
    capture: {
      start: (options) =>
        Effect.sync(() => {
          activeOptions = options;
          return Effect.void;
        }),
    },
    options: () => {
      if (activeOptions === undefined) {
        throw new Error("Recorder capture has not started.");
      }
      return activeOptions;
    },
  };
};

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(value: string): void {
    this.sent.push(value);
  }
}

it("rejects a newly opened page outside the pinned recording tab", () => {
  expect(
    isUnsupportedRecordingTarget(
      {
        method: "Target.targetCreated",
        params: {
          targetInfo: {
            openerId: "pinned-page",
            targetId: "popup-page",
            type: "page",
            url: "https://example.com/popup",
          },
        },
      },
      "pinned-page",
      false
    )
  ).toBe(true);
});

it("ignores an unrelated page discovered outside the pinned recording tab", () => {
  expect(
    isUnsupportedRecordingTarget(
      {
        method: "Target.targetCreated",
        params: {
          targetInfo: {
            targetId: "unrelated-page",
            type: "page",
            url: "https://example.org/",
          },
        },
      },
      "pinned-page",
      false
    )
  ).toBe(false);
});

it.effect(
  "preserves change-before-click order through Recording mutation",
  () =>
    Effect.gen(function* preserveRecordingOrder() {
      const capture = makeCapture();
      const recording = yield* makeRecordingService(capture.capture);
      yield* recording.start({
        initialUrl: "https://example.com/form",
        sessionId,
        tabId,
        title: "Submit form",
      });
      const releaseChange = yield* Latch.make();
      const captureOptions = capture.options();
      const ordered = makeOrderedRecorderEventHandler(
        (event) =>
          event.type === "change"
            ? releaseChange.await.pipe(
                Effect.andThen(captureOptions.onEvent(event))
              )
            : captureOptions.onEvent(event),
        captureOptions.onFailure
      );

      ordered.dispatch({
        selectors: ["#email"],
        type: "change",
        value: "a@b.c",
      });
      ordered.dispatch({
        offsetX: 10,
        offsetY: 10,
        selectors: ["aria/Submit"],
        type: "click",
      });
      yield* Effect.yieldNow;
      yield* releaseChange.open;
      yield* ordered.awaitIdle;

      const snapshot = yield* recording.get();
      expect(snapshot?.recordedSteps.map(({ step }) => step.type)).toEqual([
        "navigate",
        "change",
        "click",
      ]);
    })
);

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

it.effect("drains an accepted final event before finishing", () =>
  Effect.gen(function* drainBeforeFinish() {
    const releaseFinalEvent = yield* Latch.make();
    let ordered: ReturnType<typeof makeOrderedRecorderEventHandler> | undefined;
    const capture: RecorderCapture = {
      start: (options) =>
        Effect.sync(() => {
          ordered = makeOrderedRecorderEventHandler(
            (event) =>
              event.type === "change"
                ? releaseFinalEvent.await.pipe(
                    Effect.andThen(options.onEvent(event))
                  )
                : options.onEvent(event),
            options.onFailure
          );
          return Effect.suspend(() => {
            if (ordered === undefined) {
              return Effect.void;
            }
            return ordered.close();
          });
        }),
    };
    const recording = yield* makeRecordingService(capture);
    yield* recording.start({
      initialUrl: "https://example.com/form",
      sessionId,
      tabId,
      title: "Submit form",
    });
    if (ordered === undefined) {
      return yield* Effect.die(new Error("Recorder capture did not start."));
    }
    ordered.dispatch({
      offsetX: 10,
      offsetY: 10,
      selectors: ["aria/Open form"],
      type: "click",
    });
    yield* ordered.awaitIdle;
    ordered.dispatch({
      selectors: ["#email"],
      type: "change",
      value: "final@value.test",
    });
    const finishing = yield* Effect.forkChild(recording.finish());
    yield* Effect.yieldNow;
    ordered.dispatch({
      offsetX: 5,
      offsetY: 5,
      selectors: ["aria/Too late"],
      type: "click",
    });
    yield* releaseFinalEvent.open;
    const finished = yield* Fiber.join(finishing);

    expect(finished.phase).toBe("finished");
    expect(finished.recordedSteps.map(({ step }) => step.type)).toEqual([
      "navigate",
      "click",
      "change",
    ]);
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
        send: (method, params, recorderSessionId) =>
          Effect.sync(() => {
            commands.push({ method, params, sessionId: recorderSessionId });
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
