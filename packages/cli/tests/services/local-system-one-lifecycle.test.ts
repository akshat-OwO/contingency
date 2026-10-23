import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";

import {
  LOCAL_SYSTEM_ONE_IDLE_MS,
  makeLocalSystemOneIdle,
} from "../../src/services/local-system-one-idle.ts";
import { makeLocalSystemOneLifecycle } from "../../src/services/local-system-one-lifecycle.ts";
import type {
  LocalSystemOneLifecycleIO,
  LocalSystemOneServer,
} from "../../src/services/local-system-one-lifecycle.ts";
import {
  recoverLegacyLocalSystemOneLock,
  withLocalSystemOneLock,
} from "../../src/services/local-system-one-lock.ts";
import {
  LocalSystemOneError,
  makeLocalSystemOne,
} from "../../src/services/local-system-one.ts";
import type {
  LocalSystemOneIO,
  LocalSystemOneState,
} from "../../src/services/local-system-one.ts";

const initial: LocalSystemOneState = {
  current: {
    directory: "install-test",
    kevCommit: "a".repeat(40),
    model: "nev",
    modelId: "test/model",
    nevRevision: "b".repeat(40),
  },
  previous: null,
  server: null,
  version: 1,
};
const server: LocalSystemOneServer = {
  kevPid: 124,
  kevPort: 1235,
  kevStartIdentity: "kev",
  phase: "starting",
  pid: 123,
  port: 1234,
  startIdentity: "supervisor",
  startedAt: "now",
};
const fixture = (lock?: LocalSystemOneIO["lock"]) => {
  const files = new Map<string, string>([
    ["/owned/state.json", JSON.stringify(initial)],
  ]);
  let launches = 0;
  let running = false;
  const local = makeLocalSystemOne({
    arch: "arm64",
    download: () => Effect.void,
    id: () => crypto.randomUUID(),
    install: () => Effect.void,
    lock,
    mkdir: () => Effect.void,
    output: () => Effect.succeed(""),
    platform: "darwin",
    read: (file) => Effect.sync(() => Option.fromUndefinedOr(files.get(file))),
    remove: (file) =>
      Effect.sync(() => {
        files.delete(file);
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        const value = files.get(from);
        if (value !== undefined) {
          files.set(to, value);
        }
        files.delete(from);
      }),
    root: "/owned",
    sha256: () => Effect.succeed(""),
    smoke: () => Effect.void,
    stop: () => Effect.void,
    write: (file, value) =>
      Effect.sync(() => {
        files.set(file, value);
      }),
  });
  const io: LocalSystemOneLifecycleIO = {
    alive: () => Effect.sync(() => running),
    launch: (state) =>
      Effect.gen(function* launch() {
        launches += 1;
        running = true;
        yield* local.writeState({ ...state, server });
        return server;
      }),
    local,
    memoryPressure: Effect.succeed(false),
    metrics: () => Effect.succeed({ idleMs: 12, rssBytes: 1024 }),
    stop: () =>
      Effect.sync(() => {
        running = false;
      }),
  };
  return {
    crash: () => {
      running = false;
    },
    io,
    launches: () => launches,
    lifecycle: makeLocalSystemOneLifecycle(io),
    local,
  };
};

describe("Local System One idle lifetime", () => {
  it.effect("exits after fifteen idle minutes", () =>
    Effect.gen(function* idleTimeout() {
      const idle = yield* makeLocalSystemOneIdle;
      const waiting = yield* idle.awaitIdle.pipe(Effect.forkChild);
      yield* TestClock.adjust(LOCAL_SYSTEM_ONE_IDLE_MS - 1);
      expect(waiting.pollUnsafe() === undefined).toBe(true);
      yield* TestClock.adjust(1);
      yield* Fiber.join(waiting);
    })
  );
  it.effect(
    "keeps in-flight requests alive and restarts idle time on completion",
    () =>
      Effect.gen(function* inFlight() {
        const idle = yield* makeLocalSystemOneIdle;
        yield* idle.begin;
        const waiting = yield* idle.awaitIdle.pipe(Effect.forkChild);
        yield* TestClock.adjust(LOCAL_SYSTEM_ONE_IDLE_MS * 2);
        expect(waiting.pollUnsafe() === undefined).toBe(true);
        yield* idle.end;
        yield* TestClock.adjust(LOCAL_SYSTEM_ONE_IDLE_MS - 1);
        expect(waiting.pollUnsafe() === undefined).toBe(true);
        yield* TestClock.adjust(1);
        yield* Fiber.join(waiting);
      })
  );
});

describe("Local System One start policy", () => {
  it.effect(
    "returns before readiness and serializes concurrent callers with a real process lock",
    () =>
      Effect.gen(function* concurrentStart() {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            mkdtemp(path.join(os.tmpdir(), "system-one-lock-"))
          ),
          (dir) =>
            Effect.promise(() => rm(dir, { force: true, recursive: true }))
        );
        const test = fixture((body) =>
          withLocalSystemOneLock("python3", path.join(directory, "lock"), body)
        );
        const results = yield* Effect.all(
          [test.lifecycle.ensureStarted, test.lifecycle.ensureStarted],
          { concurrency: "unbounded" }
        );
        expect(test.launches()).toBe(1);
        expect(results.filter((result) => result.started)).toHaveLength(1);
        expect((yield* test.local.status)?.server?.phase).toBe("starting");
      }).pipe(Effect.scoped, Effect.timeout("30 seconds"))
  );
  it.effect("reports memory pressure without launching", () =>
    Effect.gen(function* pressure() {
      const test = fixture();
      const lifecycle = makeLocalSystemOneLifecycle({
        ...test.io,
        memoryPressure: Effect.succeed(true),
      });
      const result = yield* lifecycle.ensureStarted;
      expect("reason" in result && result.reason).toContain("memory pressure");
      expect(test.launches()).toBe(0);
      yield* lifecycle.start;
      expect(test.launches()).toBe(1);
    })
  );
  it.effect(
    "persists the one-restart limit across callers until explicit start",
    () =>
      Effect.gen(function* crashPolicy() {
        const test = fixture();
        yield* test.lifecycle.ensureStarted;
        test.crash();
        yield* makeLocalSystemOneLifecycle(test.io).ensureStarted;
        expect((yield* test.local.status)?.crashes).toBe(1);
        test.crash();
        const result = yield* Effect.result(
          makeLocalSystemOneLifecycle(test.io).ensureStarted
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("/owned/server.log");
        }
        expect((yield* test.local.status)?.crashes).toBe(2);
        expect(test.launches()).toBe(2);
        yield* test.lifecycle.start;
        expect((yield* test.local.status)?.crashes).toBe(0);
        expect(test.launches()).toBe(3);
      })
  );
  it.effect("waits only until the caller's readiness deadline", () =>
    Effect.gen(function* deadline() {
      const test = fixture();
      yield* test.lifecycle.ensureStarted;
      const waiting = yield* test.lifecycle
        .awaitReady((yield* Clock.currentTimeMillis) + 1000)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1000);
      const result = yield* Fiber.join(waiting);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain("still starting");
      }
      const state = yield* test.local.status;
      if (state === undefined) {
        return expect.unreachable();
      }
      yield* test.local.writeState({
        ...state,
        server: { ...server, phase: "ready" },
      });
      expect(
        (yield* test.lifecycle.awaitReady(yield* Clock.currentTimeMillis)).phase
      ).toBe("ready");
    })
  );
  it.effect("stops before clearing the recorded identity", () =>
    Effect.gen(function* stop() {
      const test = fixture();
      yield* test.lifecycle.start;
      yield* test.lifecycle.stop;
      expect((yield* test.local.status)?.server).toBeNull();
      expect((yield* test.lifecycle.status).running).toBe(false);
    })
  );
});

it.effect("releases the mutation lock when its holder is interrupted", () =>
  Effect.gen(function* interruptedLock() {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "system-one-stale-"))
      ),
      (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true }))
    );
    const entered = yield* Deferred.make<boolean>();
    const held = yield* withLocalSystemOneLock(
      "python3",
      path.join(directory, "lock"),
      Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never))
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(held);
    expect(
      yield* withLocalSystemOneLock(
        "python3",
        path.join(directory, "lock"),
        Effect.succeed("recovered")
      )
    ).toBe("recovered");
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"))
);

it.effect("counts launch failures toward the persisted crash limit", () =>
  Effect.gen(function* failedLaunch() {
    const test = fixture();
    const lifecycle = makeLocalSystemOneLifecycle({
      ...test.io,
      launch: () =>
        Effect.fail(new LocalSystemOneError({ message: "spawn failed" })),
    });
    yield* Effect.result(lifecycle.ensureStarted);
    yield* Effect.result(lifecycle.ensureStarted);
    expect((yield* test.local.status)?.crashes).toBe(2);
    const result = yield* Effect.result(lifecycle.ensureStarted);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("crashed twice");
    } else {
      expect.unreachable("automatic starts must stay disabled");
    }
  })
);

it.effect("recovers the abandoned slice-one directory lock", () =>
  Effect.gen(function* legacyLock() {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "system-one-legacy-"))
      ),
      (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true }))
    );
    const root = path.join(directory, "system-one");
    yield* Effect.promise(() => mkdir(`${root}.lock`));
    const busy = yield* Effect.result(
      recoverLegacyLocalSystemOneLock(
        root,
        Effect.succeed("999999 /usr/bin/node contingency system-one setup")
      )
    );
    expect(Result.isFailure(busy)).toBe(true);
    yield* Effect.promise(() => access(`${root}.lock`));
    yield* withLocalSystemOneLock(
      "python3",
      `${root}.mutation-lock`,
      recoverLegacyLocalSystemOneLock(root, Effect.succeed(""))
    );
    const exists = yield* Effect.promise(async () => {
      try {
        await access(`${root}.lock`);
        return true;
      } catch {
        return false;
      }
    });
    expect(exists).toBe(false);
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"))
);
