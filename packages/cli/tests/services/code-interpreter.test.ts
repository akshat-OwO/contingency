import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  INTERPRETER_LIMITS,
  resolveInterpreterEntry,
  runInterpreterProgram,
} from "../../src/services/code-interpreter.ts";
import type {
  InterpreterDispatch,
  InterpreterRunOptions,
} from "../../src/services/code-interpreter.ts";

// One hang guard per test, sized for a hung process rather than the work.
const HANG_GUARD_MS = 60_000;

const fixtures = path.join(import.meta.dirname, "../fixtures/code-interpreter");
const fixture = (name: string) => ({
  args: [path.join(fixtures, name)],
  command: process.execPath,
});

const operations = [
  {
    description: "Adds one to a server-held counter and returns it.",
    inputSchema: { properties: {}, type: "object" },
    name: "increment",
  },
  {
    description: "Acts, possibly opening a Pending Decision.",
    inputSchema: {
      properties: { operationId: { type: "string" } },
      required: ["operationId"],
      type: "object",
    },
    name: "act",
  },
] as const;

const answer = (value: Schema.Json) =>
  Effect.succeed({ ok: true as const, value });

const run = (
  options: Omit<InterpreterRunOptions, "operations" | "dispatch"> &
    Partial<Pick<InterpreterRunOptions, "dispatch">>
) =>
  runInterpreterProgram({
    dispatch: () => answer(null),
    operations: [...operations],
    ...options,
  });

/** True while a process with this id exists. */
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const guarded = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.timeout(HANG_GUARD_MS), Effect.provide(NodeServices.layer));

it.live(
  "runs a program in a process that exits, keeping the receipt",
  () =>
    guarded(
      Effect.gen(function* completes() {
        const outcome = yield* run({
          code: "const counted = await tools.increment({}); return { counted }",
          dispatch: () => answer(1),
          timeoutMs: 5000,
        });
        expect(outcome.status).toBe("completed");
        expect(outcome.value).toEqual({ counted: 1 });
        expect(outcome.receipts).toEqual([
          {
            operation: "increment",
            operationId: null,
            outcome: "succeeded",
            sequence: 1,
          },
        ]);
        expect(outcome.process.exit).toBe("exit code 0");
        expect(isAlive(outcome.process.pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "starts every program with fresh state while server state persists",
  () =>
    guarded(
      Effect.gen(function* freshState() {
        let counter = 0;
        const dispatch: InterpreterDispatch = () =>
          Effect.sync(() => {
            counter += 1;
            return { ok: true as const, value: counter };
          });
        const first = yield* run({
          code: "const leaked = await tools.increment({}); return leaked",
          dispatch,
          timeoutMs: 5000,
        });
        const second = yield* run({
          code: "return leaked",
          dispatch,
          timeoutMs: 5000,
        });
        const third = yield* run({
          code: "return await tools.increment({})",
          dispatch,
          timeoutMs: 5000,
        });
        expect(first.value).toBe(1);
        expect(second.status).toBe("program_failed");
        expect(second.diagnostic?.message).toContain("leaked");
        expect(third.value).toBe(2);
        expect(
          new Set([first, second, third].map((o) => o.process.pid)).size
        ).toBe(3);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "stops at the V8 heap ceiling of an allocating program",
  () =>
    guarded(
      Effect.gen(function* heapCeiling() {
        // About 320 MB of distinct arrays; a repeated string would be a shared
        // rope, far smaller than its length.
        const allocate =
          "const kept = []; for (let i = 0; i < 40; i++) { kept.push(new Array(1000000).fill(i)) } return kept.length";
        const bounded = yield* run({ code: allocate, timeoutMs: 30_000 });
        expect(bounded.status).toBe("memory_limit");
        expect(bounded.diagnostic?.message).toContain("V8 heap ceiling");
        expect(bounded.process.heapLimitBytes).toBe(
          (INTERPRETER_LIMITS.heapOldSpaceMiB +
            3 * INTERPRETER_LIMITS.heapSemiSpaceMiB) *
            1024 *
            1024
        );
        expect(isAlive(bounded.process.pid)).toBe(false);

        // The same program, the same process boundary, and the same output
        // truncation complete once the ceiling is raised: the ceiling is
        // what stopped it, not isolation or the result limit.
        const unbounded = yield* run({
          code: allocate,
          limits: { heapOldSpaceMiB: 4096, rssCeilingBytes: 8 * 1024 ** 3 },
          timeoutMs: 30_000,
        });
        expect(unbounded.status).toBe("completed");
        expect(unbounded.value).toBe(40);
        expect(unbounded.process.lastMemory?.heapUsedBytes).toBeGreaterThan(
          bounded.process.heapLimitBytes ?? Number.POSITIVE_INFINITY
        );
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "stops at the resident memory ceiling the heap cannot see",
  () =>
    guarded(
      Effect.gen(function* rssCeiling() {
        const outcome = yield* run({
          code: "const kept = []; for (let i = 0; i < 200; i++) { kept.push(new Uint8Array(9000000).fill(1)) } return kept.length",
          timeoutMs: 30_000,
        });
        expect(outcome.status).toBe("memory_limit");
        expect(outcome.diagnostic?.message).toContain("Resident memory");
        expect(outcome.process.peakRssBytes).toBeGreaterThan(
          INTERPRETER_LIMITS.rssCeilingBytes
        );
        expect(isAlive(outcome.process.pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "kills a program that blocks its interpreter past the deadline",
  () =>
    guarded(
      Effect.gen(function* deadline() {
        // A backtracking expression holds the interpreter's thread inside one
        // native call, where its own timeout cannot fire.
        const outcome = yield* run({
          code: "return /^(a+)+$/.test('a'.repeat(40) + 'b')",
          limits: { graceMs: 500 },
          timeoutMs: 1000,
        });
        expect(outcome.status).toBe("deadline_exceeded");
        expect(outcome.process.exit).toContain("SIGKILL");
        expect(isAlive(outcome.process.pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "kills the process when its execution is cancelled",
  () =>
    guarded(
      Effect.gen(function* cancel() {
        const started = yield* Deferred.make<number>();
        const dispatched = yield* Deferred.make<"dispatched">();
        const execution = yield* run({
          code: "await tools.increment({}); return 'unreachable'",
          dispatch: () =>
            Deferred.succeed(dispatched, "dispatched").pipe(
              Effect.andThen(Effect.never)
            ),
          onStart: (pid) => Deferred.succeed(started, pid).pipe(Effect.asVoid),
          timeoutMs: 60_000,
        }).pipe(Effect.forkChild);
        const pid = yield* Deferred.await(started);
        yield* Deferred.await(dispatched);
        expect(isAlive(pid)).toBe(true);
        yield* Fiber.interrupt(execution);
        expect(isAlive(pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "ends a program at a Pending Decision without dispatching more",
  () =>
    guarded(
      Effect.gen(function* intervention() {
        const dispatched: string[] = [];
        const outcome = yield* run({
          code: "await tools.act({ operationId: 'first' }); await tools.act({ operationId: 'second' }); return 'unreachable'",
          dispatch: (_operation, input) =>
            Effect.sync(() => {
              dispatched.push(JSON.stringify(input));
              return {
                ok: true as const,
                pendingDecision: { id: "boundary-1" },
                value: { paused: true },
              };
            }),
          timeoutMs: 5000,
        });
        expect(outcome.status).toBe("intervention");
        expect(outcome.pendingDecision).toEqual({ id: "boundary-1" });
        expect(dispatched).toEqual(['{"operationId":"first"}']);
        expect(outcome.receipts).toEqual([
          {
            operation: "act",
            operationId: "first",
            outcome: "succeeded",
            sequence: 1,
          },
        ]);
        expect(isAlive(outcome.process.pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "dispatches no queued request after its program ends",
  () =>
    guarded(
      Effect.gen(function* queuedAfterEnd() {
        const holding = yield* Deferred.make<"holding">();
        const release = yield* Deferred.make<"released">();
        const ended = yield* Deferred.make<"ended">();
        const dispatched: string[] = [];
        const execution = yield* run({
          // Both requests leave at once; the action queues behind the hold.
          code: "return await Promise.all([tools.increment({}), tools.act({ operationId: 'late' })])",
          dispatch: (operation) =>
            Effect.gen(function* holdFirst() {
              dispatched.push(operation);
              yield* Deferred.succeed(holding, "holding");
              yield* Deferred.await(release);
              return { ok: true as const, value: null };
            }),
          onProgramEnd: Deferred.succeed(ended, "ended").pipe(Effect.asVoid),
          timeoutMs: 1000,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(holding);
        // The interpreter's own timeout ends the program during the hold.
        yield* Deferred.await(ended);
        yield* Deferred.succeed(release, "released");
        const outcome = yield* Fiber.join(execution);
        expect(dispatched).toEqual(["increment"]);
        expect(outcome.status).toBe("program_failed");
        expect(outcome.diagnostic?.kind).toBe("TimeoutExceeded");
        expect(outcome.receipts).toEqual([
          {
            operation: "increment",
            operationId: null,
            outcome: "succeeded",
            sequence: 1,
          },
          {
            message: "The program ended before this operation was dispatched.",
            operation: "act",
            operationId: "late",
            outcome: "rejected",
            sequence: 2,
          },
        ]);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "refuses a malformed process message",
  () =>
    guarded(
      Effect.gen(function* malformed() {
        const outcome = yield* run({
          code: "return 1",
          command: fixture("malformed-ready.mjs"),
          timeoutMs: 5000,
        });
        expect(outcome.status).toBe("protocol_violation");
        expect(outcome.diagnostic?.message).toContain("extra");
        expect(isAlive(outcome.process.pid)).toBe(false);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "rejects an operation the server never offered",
  () =>
    guarded(
      Effect.gen(function* unknownOperation() {
        let dispatches = 0;
        const outcome = yield* run({
          code: "return 1",
          command: fixture("unknown-operation.mjs"),
          dispatch: () =>
            Effect.sync(() => {
              dispatches += 1;
              return { ok: true as const, value: null };
            }),
          timeoutMs: 5000,
        });
        expect(dispatches).toBe(0);
        expect(outcome.receipts).toEqual([
          {
            message:
              "agent_session_close is not an operation this program may request.",
            operation: "agent_session_close",
            operationId: null,
            outcome: "rejected",
            sequence: 1,
          },
        ]);
        expect(outcome.value).toEqual({
          message:
            "agent_session_close is not an operation this program may request.",
          ok: false,
        });
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "reports an interpreter that crashes mid-program",
  () =>
    guarded(
      Effect.gen(function* crash() {
        const outcome = yield* run({
          code: "return 1",
          command: fixture("crash-after-ready.mjs"),
          timeoutMs: 5000,
        });
        expect(outcome.status).toBe("crashed");
        expect(outcome.diagnostic?.message).toContain("exit code 7");
        expect(outcome.receipts).toEqual([]);
      })
    ),
  HANG_GUARD_MS
);

it.live(
  "ends the interpreter when its parent dies without cleanup",
  () =>
    guarded(
      Effect.gen(function* orphan() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const parent = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              path.join(fixtures, "abandoning-parent.mjs"),
              resolveInterpreterEntry(
                path.join(import.meta.dirname, "../../src/services")
              ),
            ],
            { additionalFds: { fd3: { type: "output" } } }
          )
        );
        // This test holds the interpreter's stdin open, so the closing pipe
        // cannot end it; only its watchdog can.
        const input = yield* Queue.unbounded<Uint8Array>();
        yield* Stream.fromQueue(input).pipe(
          Stream.run(parent.stdin),
          Effect.forkScoped
        );
        yield* Queue.offer(
          input,
          new TextEncoder().encode(
            `${JSON.stringify({
              code: "return /^(a+)+$/.test('a'.repeat(40) + 'b')",
              limits: {
                maxOutputBytes: 1000,
                maxToolCalls: 1,
                timeoutMs: 600_000,
              },
              operations: [],
              type: "execute",
            })}\n`
          )
        );
        const lines = yield* Queue.unbounded<string>();
        const drained = yield* parent.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => Queue.offer(lines, line)),
          Effect.forkScoped
        );
        const telemetry = yield* parent
          .getOutputFd(3)
          .pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runCollect,
            Effect.forkScoped
          );
        expect(yield* Queue.take(lines)).toContain('"ready"');
        // Only the parent: its process group also holds the interpreter.
        process.kill(parent.pid, "SIGKILL");
        // The orphaned interpreter closes the last copies of both streams.
        yield* Fiber.join(drained);
        expect(yield* Fiber.join(telemetry)).toContain('{"type":"orphaned"}');
      }).pipe(Effect.scoped)
    ),
  HANG_GUARD_MS
);
