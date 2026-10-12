import path from "node:path";

import { Effect, Fiber, Option, Queue, Result, Schema, Stream } from "effect";
import type { Types } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  InterpreterMessage,
  WatchdogMessage,
  encodeLine,
  strictDecode,
} from "./code-interpreter-protocol.ts";
import type {
  OfferedOperation,
  MemoryReading,
  ServerInstruction,
} from "./code-interpreter-protocol.ts";

/**
 * Runs one program in a fresh OpenCode interpreter process, a feasibility
 * prototype for ADR 0059 (#459).
 *
 * The server owns everything with authority: it decides which operations
 * exist, validates every request, dispatches it, and keeps the receipt. The
 * process only interprets code, and it lives for exactly one program, so no
 * program state outlives an execution. The server enforces every limit
 * itself: a V8 heap ceiling the process cannot raise, a resident memory
 * ceiling its watchdog thread enforces, and a deadline after which the whole
 * process group is killed whether or not the interpreter still responds.
 */

export const INTERPRETER_LIMITS = {
  /** Characters of program source. */
  codeCharacters: 16_384,
  defaultTimeoutMs: 30_000,
  /** After the program budget, how long before the process is killed. */
  graceMs: 1000,
  /** V8 old-space ceiling: strings, arrays, objects, interpreter state. */
  heapOldSpaceMiB: 96,
  /** Each young-generation semi-space; three of them join the old space. */
  heapSemiSpaceMiB: 2,
  maxOutputBytes: 16_384,
  /** Long enough for a full Session Event wait (ADR 0055) and more. */
  maxTimeoutMs: 120_000,
  maxToolCalls: 50,
  minTimeoutMs: 1000,
  /** Process resident memory, which also counts ArrayBuffer storage. */
  rssCeilingBytes: 320 * 1024 * 1024,
  /** How long a process may take to load before it is treated as failed. */
  startupMs: 10_000,
  watchdogIntervalMs: 5,
} as const;

/** Limits a caller may change, such as a test that needs to reach one. */
export interface InterpreterLimitOverrides {
  readonly heapOldSpaceMiB?: number;
  readonly rssCeilingBytes?: number;
  readonly graceMs?: number;
  readonly startupMs?: number;
}

export type DispatchOutcome =
  | {
      readonly ok: true;
      readonly value: Schema.Json;
      /**
       * A Pending Decision this operation opened. The program ends here: no
       * later request is dispatched, and the decision goes back to the agent.
       */
      readonly pendingDecision?: Schema.Json | undefined;
    }
  | { readonly ok: false; readonly message: string };

/** What the server does with one requested operation. */
export type InterpreterDispatch = (
  operation: string,
  input: Schema.Json
) => Effect.Effect<DispatchOutcome>;

export interface InterpreterReceipt {
  readonly sequence: number;
  readonly operation: string;
  /** The operation id the program supplied, when the operation takes one. */
  readonly operationId: string | null;
  /** `rejected` was never dispatched; `failed` was, and was refused. */
  readonly outcome: "succeeded" | "failed" | "rejected";
  readonly message?: string;
}

export type InterpreterStatus =
  | "completed"
  | "program_failed"
  | "intervention"
  | "deadline_exceeded"
  | "memory_limit"
  | "crashed"
  | "protocol_violation";

/** How a program ended, before the process facts are added. */
export interface InterpreterEnding {
  readonly status: InterpreterStatus;
  readonly value?: Schema.Json;
  readonly diagnostic?: { readonly kind: string; readonly message: string };
  readonly logs?: readonly string[];
  readonly truncated?: boolean;
  readonly pendingDecision?: Schema.Json;
}

export interface InterpreterProcessReport {
  readonly pid: number;
  /** What V8 reports it will allow, young generation included. */
  readonly heapLimitBytes: number | null;
  readonly rssCeilingBytes: number;
  /** The highest resident memory the server saw reported. */
  readonly peakRssBytes: number | null;
  readonly lastMemory: MemoryReading | null;
  readonly startupMs: number | null;
  readonly durationMs: number;
  /** Protocol bytes each way, the cost of the process boundary. */
  readonly bytesToInterpreter: number;
  readonly bytesFromInterpreter: number;
  readonly exit: string;
}

export interface InterpreterOutcome extends InterpreterEnding {
  readonly receipts: readonly InterpreterReceipt[];
  readonly process: InterpreterProcessReport;
}

export interface InterpreterRunOptions {
  readonly code: string;
  readonly timeoutMs: number;
  readonly operations: readonly OfferedOperation[];
  readonly dispatch: InterpreterDispatch;
  readonly limits?: InterpreterLimitOverrides | undefined;
  /** Another interpreter entry, such as the built one, under the same flags. */
  readonly entry?: string | undefined;
  /** Observes the process as soon as it exists, before it is ready. */
  readonly onStart?: ((pid: number) => Effect.Effect<void>) | undefined;
  /** Replaces the interpreter process, so tests can speak a broken protocol. */
  readonly command?:
    | { readonly command: string; readonly args: readonly string[] }
    | undefined;
}

/**
 * The interpreter entry beside this module: built into `dist` for the
 * package, run from source by Node's type stripping in a checkout.
 */
export const resolveInterpreterEntry = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "code-interpreter-process.js")
    : path.join(moduleDirectory, "code-interpreter-process.ts");

const interpreterEntry = resolveInterpreterEntry(import.meta.dirname);

const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InterpreterMessage),
  strictDecode
);
const decodeWatchdog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WatchdogMessage),
  strictDecode
);
const decodeOperationId = Schema.decodeUnknownOption(
  Schema.Struct({ operationId: Schema.String })
);

const operationIdOf = (input: Schema.Json): string | null =>
  Option.match(decodeOperationId(input), {
    onNone: () => null,
    onSome: ({ operationId }) => operationId,
  });

const HEAP_EXHAUSTED = /heap out of memory|Reached heap limit/u;

/** A process exit, as code or signal. */
const describeExit = (
  exit: Result.Result<
    number,
    { readonly message: string; readonly cause?: unknown }
  >
): string => {
  if (Result.isSuccess(exit)) {
    return `exit code ${exit.success}`;
  }
  if (exit.failure.cause instanceof Error) {
    return exit.failure.cause.message;
  }
  return exit.failure.message;
};

const violation = (message: string): InterpreterEnding => ({
  diagnostic: { kind: "ProtocolViolation", message },
  status: "protocol_violation",
});

const deadlineExceeded = (
  budgetMs: number,
  phase: string
): InterpreterEnding => ({
  diagnostic: {
    kind: "DeadlineExceeded",
    message: `The interpreter ${phase} past ${budgetMs} ms and its process was killed.`,
  },
  status: "deadline_exceeded",
});

/** The program's own ending, as the interpreter reported it. */
const finishedEnding = (
  done: Extract<typeof InterpreterMessage.Type, { readonly type: "done" }>
): InterpreterEnding => {
  const ending: Types.Mutable<InterpreterEnding> = {
    status: done.ok ? "completed" : "program_failed",
  };
  if (done.ok) {
    ending.value = done.value ?? null;
  }
  if (done.error !== undefined) {
    ending.diagnostic = done.error;
  }
  if (done.logs !== undefined) {
    ending.logs = done.logs;
  }
  if (done.truncated !== undefined) {
    ending.truncated = done.truncated;
  }
  return ending;
};

const receiptFor = (
  sequence: number,
  operation: string,
  operationId: string | null,
  outcome: DispatchOutcome
): InterpreterReceipt => {
  const receipt: Types.Mutable<InterpreterReceipt> = {
    operation,
    operationId,
    outcome: outcome.ok ? "succeeded" : "failed",
    sequence,
  };
  if (!outcome.ok) {
    receipt.message = outcome.message;
  }
  return receipt;
};

type Line =
  | { readonly _tag: "line"; readonly text: string }
  | { readonly _tag: "end" };

interface MemoryObservation {
  heapLimitBytes: number | null;
  last: MemoryReading | null;
  peakRss: number | null;
  rssCeilingHit: boolean;
  startupMs: number | null;
}

export const runInterpreterProgram = Effect.fn("runInterpreterProgram")(
  function* runProgram(options: InterpreterRunOptions) {
    const limits = { ...INTERPRETER_LIMITS, ...options.limits };
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const started = Date.now();
    const receipts: InterpreterReceipt[] = [];
    const io = { fromInterpreter: 0, toInterpreter: 0 };
    const memory: MemoryObservation = {
      heapLimitBytes: null,
      last: null,
      peakRss: null,
      rssCeilingHit: false,
      startupMs: null,
    };
    const observe = (usage: MemoryReading) => {
      memory.last = usage;
      memory.peakRss = Math.max(memory.peakRss ?? 0, usage.rssBytes);
    };

    const watchdog = JSON.stringify({
      intervalMs: limits.watchdogIntervalMs,
      rssCeilingBytes: limits.rssCeilingBytes,
    });
    const command = options.command ?? {
      args: [
        `--max-old-space-size=${limits.heapOldSpaceMiB}`,
        `--max-semi-space-size=${limits.heapSemiSpaceMiB}`,
        "--disallow-code-generation-from-strings",
        options.entry ?? interpreterEntry,
        watchdog,
      ],
      command: process.execPath,
    };

    return yield* Effect.scoped(
      Effect.gen(function* inProcess() {
        // Its own process group, killed outright on every exit path: the
        // interpreter has nothing to flush, and an unresponsive one would
        // ignore a polite signal.
        const child = yield* spawner.spawn(
          ChildProcess.make(command.command, [...command.args], {
            additionalFds: { fd3: { type: "output" } },
            env: {},
            extendEnv: false,
            killSignal: "SIGKILL",
          })
        );
        if (options.onStart !== undefined) {
          yield* options.onStart(child.pid);
        }
        const input = yield* Queue.unbounded<Uint8Array>();
        const write = (message: ServerInstruction) =>
          Effect.suspend(() => {
            const bytes = new TextEncoder().encode(encodeLine(message));
            io.toInterpreter += bytes.byteLength;
            return Queue.offer(input, bytes);
          });
        yield* Stream.fromQueue(input).pipe(
          Stream.run(child.stdin),
          Effect.ignore,
          Effect.forkScoped
        );

        const lines = yield* Queue.unbounded<Line>();
        yield* child.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              io.fromInterpreter += chunk.byteLength;
            })
          ),
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((text) =>
            Queue.offer(lines, { _tag: "line", text })
          ),
          Effect.ignore,
          Effect.andThen(Queue.offer(lines, { _tag: "end" })),
          Effect.forkScoped
        );
        const telemetry = yield* child.getOutputFd(3).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((text) =>
            decodeWatchdog(text).pipe(
              Effect.tap((message) =>
                Effect.sync(() => {
                  if (message.type !== "orphaned") {
                    observe(message.memory);
                  }
                  if (message.type === "rss_ceiling") {
                    memory.rssCeilingHit = true;
                  }
                })
              ),
              Effect.ignore
            )
          ),
          Effect.ignore,
          Effect.forkScoped
        );
        const stderr = yield* child.stderr.pipe(
          Stream.decodeText,
          Stream.mkString,
          Effect.orElseSucceed(() => ""),
          Effect.forkScoped
        );

        /** Why the process ended without finishing its program. */
        const classifyExit = Effect.gen(function* classify() {
          const exit = yield* Effect.result(child.exitCode).pipe(
            Effect.timeoutOption(2000)
          );
          yield* Fiber.join(telemetry).pipe(Effect.timeoutOption(1000));
          const errors = yield* Fiber.join(stderr).pipe(
            Effect.timeoutOption(1000),
            Effect.map(Option.getOrElse(() => ""))
          );
          const how = Option.match(exit, {
            onNone: () => "still running",
            onSome: describeExit,
          });
          if (memory.rssCeilingHit) {
            return {
              diagnostic: {
                kind: "MemoryLimitExceeded",
                message: `Resident memory passed ${limits.rssCeilingBytes} bytes; the process was killed (${how}).`,
              },
              status: "memory_limit",
            } satisfies InterpreterEnding;
          }
          if (HEAP_EXHAUSTED.test(errors)) {
            return {
              diagnostic: {
                kind: "MemoryLimitExceeded",
                message: `The V8 heap ceiling of ${limits.heapOldSpaceMiB} MiB old space was reached; the process aborted (${how}).`,
              },
              status: "memory_limit",
            } satisfies InterpreterEnding;
          }
          return {
            diagnostic: {
              kind: "InterpreterCrashed",
              message:
                `The interpreter process ended without a result (${how}). ${errors.slice(0, 500)}`.trim(),
            },
            status: "crashed",
          } satisfies InterpreterEnding;
        });

        /** Reads one decoded message, or why there is none. */
        const next = Effect.gen(function* readMessage() {
          const line = yield* Queue.take(lines);
          if (line._tag === "end") {
            return { _tag: "ended" as const };
          }
          const decoded = yield* Effect.result(decodeMessage(line.text));
          if (Result.isFailure(decoded)) {
            return {
              _tag: "malformed" as const,
              message: `Malformed interpreter message: ${decoded.failure.message.slice(0, 500)}`,
            };
          }
          return { _tag: "message" as const, message: decoded.success };
        });

        const known = new Set(options.operations.map(({ name }) => name));
        let sequence = 0;

        const startup = Effect.gen(function* awaitReady() {
          const first = yield* next;
          if (first._tag === "ended") {
            return Option.some(yield* classifyExit);
          }
          if (first._tag === "malformed") {
            return Option.some(violation(first.message));
          }
          if (first.message.type !== "ready") {
            return Option.some(
              violation(`Expected ready, received ${first.message.type}.`)
            );
          }
          memory.heapLimitBytes = first.message.heapLimitBytes;
          memory.startupMs = Date.now() - started;
          return Option.none<InterpreterEnding>();
        });

        const program = Effect.gen(function* runToEnd() {
          yield* write({
            code: options.code,
            limits: {
              maxOutputBytes: INTERPRETER_LIMITS.maxOutputBytes,
              maxToolCalls: INTERPRETER_LIMITS.maxToolCalls,
              timeoutMs: options.timeoutMs,
            },
            operations: options.operations,
            type: "execute",
          });
          while (true) {
            const read = yield* next;
            if (read._tag === "ended") {
              return yield* classifyExit;
            }
            if (read._tag === "malformed") {
              return violation(read.message);
            }
            const { message } = read;
            if (message.type === "ready") {
              return violation("The interpreter announced itself twice.");
            }
            if (message.type === "done") {
              observe(message.memory);
              return finishedEnding(message);
            }
            sequence += 1;
            const operationId = operationIdOf(message.input);
            if (!known.has(message.operation)) {
              const refusal = `${message.operation} is not an operation this program may request.`;
              receipts.push({
                message: refusal,
                operation: message.operation,
                operationId,
                outcome: "rejected",
                sequence,
              });
              yield* write({
                id: message.id,
                outcome: { message: refusal, ok: false },
                type: "result",
              });
              continue;
            }
            const outcome = yield* options.dispatch(
              message.operation,
              message.input
            );
            receipts.push(
              receiptFor(sequence, message.operation, operationId, outcome)
            );
            if (outcome.ok && outcome.pendingDecision !== undefined) {
              // The program ends before it can request anything else. The
              // process is killed next; the cancel only saves it the wait.
              yield* write({ reason: "intervention", type: "cancel" });
              return {
                pendingDecision: outcome.pendingDecision,
                status: "intervention",
                value: outcome.value,
              } satisfies InterpreterEnding;
            }
            yield* write({
              id: message.id,
              outcome: outcome.ok
                ? { ok: true, value: outcome.value }
                : { message: outcome.message, ok: false },
              type: "result",
            });
          }
        });

        const ended = yield* startup.pipe(
          Effect.timeoutOption(limits.startupMs),
          Effect.map(
            Option.getOrElse(() =>
              Option.some(deadlineExceeded(limits.startupMs, "took to start"))
            )
          )
        );
        const ending = Option.isSome(ended)
          ? ended.value
          : yield* program.pipe(
              Effect.timeoutOption(options.timeoutMs + limits.graceMs),
              Effect.map(
                Option.getOrElse(() =>
                  deadlineExceeded(options.timeoutMs + limits.graceMs, "ran")
                )
              )
            );
        // A finished program exits by itself; anything else is killed now
        // rather than at scope close, so the reported exit is final.
        if (
          ending.status === "completed" ||
          ending.status === "program_failed"
        ) {
          yield* Effect.result(child.exitCode).pipe(Effect.timeoutOption(1000));
        }
        yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
        const exit = yield* Effect.result(child.exitCode);
        const outcome: InterpreterOutcome = {
          ...ending,
          process: {
            bytesFromInterpreter: io.fromInterpreter,
            bytesToInterpreter: io.toInterpreter,
            durationMs: Date.now() - started,
            exit: describeExit(exit),
            heapLimitBytes: memory.heapLimitBytes,
            lastMemory: memory.last,
            peakRssBytes: memory.peakRss,
            pid: child.pid,
            rssCeilingBytes: limits.rssCeilingBytes,
            startupMs: memory.startupMs,
          },
          receipts,
        };
        return outcome;
      })
    );
  }
);
