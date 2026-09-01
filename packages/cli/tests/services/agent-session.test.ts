import {
  makeBrowserRpcError,
  OperationId,
  SessionId,
} from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";

import {
  AgentSession,
  makeAgentSessionLayer,
  makeAgentSessionService,
} from "../../src/services/agent-session.ts";
import type { AgentSessionStartInput } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import type { CreateBrowserService } from "../../src/services/create-browser-contract.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

interface FakeBrowser {
  readonly browser: CreateBrowserService;
  readonly closed: SessionId[];
  readonly created: SessionId[];
}

const notUnderTest = () => Effect.die("Not under test.");

const makeFakeBrowser = (options?: {
  readonly blockClose?: {
    readonly entered: Deferred.Deferred<true>;
    readonly release: Deferred.Deferred<true>;
  };
  readonly blockCurrentUrl?: Deferred.Deferred<true>;
  readonly failCurrentUrl?: boolean;
  readonly failOpen?: boolean;
}): FakeBrowser => {
  const created: SessionId[] = [];
  const closed: SessionId[] = [];
  const blockClose = options?.blockClose;
  const blockCurrentUrl = options?.blockCurrentUrl;
  const failure = makeBrowserRpcError(
    "agent_browser_failed",
    "The fake browser failed."
  );
  const browser: CreateBrowserService = {
    acknowledgeFrame: notUnderTest,
    clearStorage: notUnderTest,
    close: (sessionId) => {
      if (blockClose === undefined) {
        return Effect.sync(() => {
          closed.push(sessionId);
        });
      }
      return Effect.gen(function* blockedClose() {
        closed.push(sessionId);
        yield* Deferred.succeed(blockClose.entered, true);
        yield* Deferred.await(blockClose.release);
      });
    },
    closeTab: notUnderTest,
    create: () =>
      Effect.sync(() => {
        const sessionId = SessionId.make(`create-agent-${created.length + 1}`);
        created.push(sessionId);
        return sessionId;
      }),
    currentUrl: () => {
      if (blockCurrentUrl !== undefined) {
        return Effect.gen(function* blockedCurrentUrl() {
          yield* Deferred.succeed(blockCurrentUrl, true);
          return yield* Effect.never;
        });
      }
      return options?.failCurrentUrl
        ? Effect.fail(failure)
        : Effect.succeed("about:blank");
    },
    deleteStorage: notUnderTest,
    getEmulation: notUnderTest,
    getNetworkRequest: notUnderTest,
    getNetworkRequests: notUnderTest,
    getStorage: notUnderTest,
    getTabs: notUnderTest,
    list: notUnderTest,
    navigate: notUnderTest,
    newTab: notUnderTest,
    open: (sessionId, url) => {
      if (options?.failOpen || sessionId === undefined) {
        return Effect.fail(failure);
      }
      return Effect.succeed({ sessionId, url });
    },
    recorderTarget: notUnderTest,
    sendInput: notUnderTest,
    setEmulation: notUnderTest,
    setStorage: notUnderTest,
    setUserAgent: notUnderTest,
    setViewport: notUnderTest,
    stream: () => Stream.never,
    switchTab: notUnderTest,
  };
  return { browser, closed, created };
};

const startInput = (operationId: string): AgentSessionStartInput => ({
  activity: "run",
  clientName: "test-agent",
  clientVersion: "1",
  name: "test-session",
  operationId: OperationId.make(operationId),
  url: "data:text/html,<main>test</main>",
  viewport,
});

const serviceFor = (fake: FakeBrowser, baseUrl = "http://127.0.0.1:7777") =>
  makeAgentSessionService(fake.browser, {
    baseUrl,
    processId: "test-owner",
  });

it.effect("replays identical mutations and rejects operation-id reuse", () =>
  Effect.gen(function* idempotentAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const input = startInput("start-once");
    const started = yield* service.start(input);
    const replay = yield* service.start(input);

    expect(replay).toEqual(started);
    expect(fake.created).toHaveLength(1);

    const startConflict = yield* Effect.flip(
      service.start({ ...input, name: "different-session" })
    );
    expect(startConflict.code).toBe("agent_session_conflict");
    expect(fake.created).toHaveLength(1);

    const closed = yield* service.close(
      started.id,
      OperationId.make("close-once")
    );
    const closeReplay = yield* service.close(
      started.id,
      OperationId.make("close-once")
    );
    expect(closeReplay).toEqual(closed);
    expect(fake.closed).toHaveLength(1);

    const closeConflict = yield* Effect.flip(
      service.close(started.id, OperationId.make("start-once"))
    );
    expect(closeConflict.code).toBe("agent_session_conflict");
    expect(fake.closed).toHaveLength(1);
  })
);

it.effect("closes and forgets a session when setup fails", () =>
  Effect.gen(function* failedAgentSession() {
    const fake = makeFakeBrowser({ failOpen: true });
    const service = yield* serviceFor(fake);
    const failure = yield* Effect.flip(service.start(startInput("failed")));

    expect(failure).toEqual<BrowserRpcErrorType>(
      makeBrowserRpcError("agent_browser_failed", "The fake browser failed.")
    );
    expect(fake.created).toHaveLength(1);
    expect(fake.closed).toEqual(fake.created);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("closes a browser when setup is interrupted", () =>
  Effect.gen(function* interruptedSetup() {
    const setupEntered = yield* Deferred.make<true>();
    const fake = makeFakeBrowser({ blockCurrentUrl: setupEntered });
    const context = yield* Layer.build(
      makeAgentSessionLayer({
        baseUrl: "http://127.0.0.1:7777",
        processId: "test-owner",
      }).pipe(
        Layer.provideMerge(Layer.succeed(CreateBrowser, fake.browser)),
        Layer.provideMerge(NodeServices.layer)
      )
    );
    const service = Context.get(context, AgentSession);
    const start = yield* Effect.forkChild(
      service.start(startInput("interrupted"))
    );

    yield* Deferred.await(setupEntered);
    yield* Fiber.interrupt(start);

    expect(fake.closed).toEqual(fake.created);
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  }).pipe(Effect.scoped)
);

it.effect("keeps close atomic when browser cleanup is interrupted", () =>
  Effect.gen(function* interruptedClose() {
    const closeEntered = yield* Deferred.make<true>();
    const releaseClose = yield* Deferred.make<true>();
    const fake = makeFakeBrowser({
      blockClose: { entered: closeEntered, release: releaseClose },
    });
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("close-interrupted"));
    const operationId = OperationId.make("close-after-interrupt");
    const close = yield* Effect.forkChild(
      service.close(started.id, operationId)
    );

    yield* Deferred.await(closeEntered);
    close.interruptUnsafe();
    yield* Deferred.succeed(releaseClose, true);
    yield* Effect.yieldNow;
    const closeExit = yield* Effect.exit(Fiber.join(close));

    expect(Exit.isFailure(closeExit)).toBe(true);
    expect(fake.closed).toEqual(fake.created);
    expect(fake.closed).toHaveLength(1);
    const closed = yield* service.close(started.id, operationId);
    expect(closed.phase).toBe("closed");
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("does not miss changes while delivering the initial snapshot", () =>
  Effect.gen(function* subscribedBeforeInitialSnapshot() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("stream-close"));
    const initialDelivered = yield* Deferred.make<true>();
    const releaseInitial = yield* Deferred.make<true>();
    let isInitial = true;
    const snapshotsFiber = yield* Effect.forkChild(
      service.changes(started.id).pipe(
        Stream.mapEffect((snapshot) => {
          if (!isInitial) {
            return Effect.succeed(snapshot);
          }
          isInitial = false;
          return Deferred.succeed(initialDelivered, true).pipe(
            Effect.andThen(Deferred.await(releaseInitial)),
            Effect.as(snapshot)
          );
        }),
        Stream.take(2),
        Stream.runCollect
      )
    );

    yield* Deferred.await(initialDelivered);
    yield* service.close(started.id);
    yield* Deferred.succeed(releaseInitial, true);
    const snapshots = yield* Fiber.join(snapshotsFiber);

    expect([...snapshots].map(({ phase }) => phase)).toEqual([
      "running",
      "closed",
    ]);
  })
);

it.effect("marks live sessions interrupted during owner shutdown", () =>
  Effect.gen(function* interruptedAgentSession() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake);
    const started = yield* service.start(startInput("shutdown"));

    yield* service.closeAll();
    const interrupted = yield* service.get(started.id);
    expect(interrupted.phase).toBe("interrupted");
    expect(interrupted.controller).toBe("agent");
    expect(interrupted.error).toContain("owning process stopped");
    expect(fake.closed).toHaveLength(1);

    yield* service.closeAll();
    expect(fake.closed).toHaveLength(1);
    expect(yield* service.list()).toEqual([]);
  })
);

it.effect("refuses a non-loopback Agent View before opening a browser", () =>
  Effect.gen(function* invalidAgentView() {
    const fake = makeFakeBrowser();
    const service = yield* serviceFor(fake, "https://agent.example");
    const failure = yield* Effect.flip(service.start(startInput("invalid")));

    expect(failure.code).toBe("agent_session_invalid");
    expect(fake.created).toHaveLength(0);
  })
);
