import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
} from "node:child_process";

import {
  Cause,
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Stream,
} from "effect";
import type { Scope, Tracer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { ChildProcess as ChildProcessCommand } from "effect/process";

import { droppedCause } from "./failure-reference.ts";

/**
 * Every child process Contingency starts goes through this module. A wrapper
 * keeps only its protocol; the module owns the rest:
 *
 * - a `child.process` span for the process's life,
 * - one share-safe log record when it ends: exit code, signal, duration,
 *   byte counts, and the codes its wrapper recognizes, never its output. A
 *   clean exit logs at Trace; any other ending at Debug, which the
 *   Diagnostic Log keeps,
 * - a bounded tail of its output, kept in memory on its `ChildProcessFailure`
 *   for a Failure Reference's debug detail, never logged,
 * - a typed failure, and a kill owned by the scope it was started in
 *   ([ADR 0089](../../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 */

/** How much of a child's stderr, and a one-shot's stdout, stays in memory. */
export const CHILD_TAIL_BYTES = 8192;
/** How long a signalled child may take to exit before it is killed outright. */
const STOP_GRACE_MS = 5000;
/** A one-shot's stdout ceiling unless its caller sets one. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Codes a wrapper reads from a child's output, such as agent-device's. */
export interface Recognized {
  readonly code?: string | undefined;
  readonly reason?: string | undefined;
}

/** How a child's life ended, as the log record and the failure state it. */
export type ChildOutcome =
  | "succeeded"
  | "stopped"
  | "spawn_failed"
  | "exited"
  | "signaled"
  | "timed_out"
  | "output_limit";

export type ChildFailureCode = Exclude<ChildOutcome, "succeeded" | "stopped">;

/** A child process that failed, by its shape. Its output is kept apart. */
export class ChildProcessFailure extends Data.TaggedError(
  "ChildProcessFailure"
)<{
  /** The wrapper's fixed name for the process, such as `ffmpeg`. */
  readonly child: string;
  readonly code: ChildFailureCode;
  readonly durationMs: number;
  /** The errno of a process that could not start, such as `ENOENT`. */
  readonly errno: string | undefined;
  readonly exitCode: number | null;
  readonly message: string;
  readonly recognized: Recognized;
  readonly signal: string | null;
}> {}

/** What a failed child printed, kept off the failure so no encoding carries it. */
export interface ChildOutput {
  readonly stderr: string;
  readonly stdout?: string | undefined;
}

const outputs = new WeakMap<ChildProcessFailure, ChildOutput>();

/** The output tail a failed child left, if it left any. */
export const childOutput = (
  failure: ChildProcessFailure
): Option.Option<ChildOutput> => Option.fromUndefinedOr(outputs.get(failure));

/** A byte tail that keeps only the last `limit` bytes it was given. */
export const boundedTail = (limit = CHILD_TAIL_BYTES) => {
  let tail = Buffer.alloc(0);
  let bytes = 0;
  return {
    bytes: () => bytes,
    push: (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += next.byteLength;
      tail =
        next.byteLength >= limit
          ? Buffer.from(next.subarray(next.byteLength - limit))
          : Buffer.concat([
              tail.subarray(
                Math.max(0, tail.byteLength + next.byteLength - limit)
              ),
              next,
            ]);
    },
    text: () => {
      // Malformed UTF-8 expands to replacement characters. Bound the encoded
      // result too, then skip any leading continuation bytes after clipping.
      const decoded = Buffer.from(tail.toString("utf-8"));
      let start = Math.max(0, decoded.byteLength - limit);
      while (
        start < decoded.byteLength &&
        decoded.readUInt8(start) >= 128 &&
        decoded.readUInt8(start) < 192
      ) {
        start += 1;
      }
      return decoded.subarray(start).toString("utf-8");
    },
  };
};

/**
 * What the module needs of a started process. Node's `ChildProcess`
 * satisfies it; a test can start a fake.
 */
export interface ChildLike {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly kill: (signal: NodeJS.Signals) => boolean;
  readonly once: (
    event: "close" | "error",
    listener: (...args: readonly unknown[]) => void
  ) => void;
  readonly pid?: number | undefined;
  readonly stderr: {
    readonly on: (
      event: "data",
      listener: (chunk: Buffer | string) => void
    ) => void;
  } | null;
}

/** How a child ended. */
export interface ChildExit {
  readonly durationMs: number;
  readonly errno: string | undefined;
  readonly exitCode: number | null;
  readonly outcome: ChildOutcome;
  readonly recognized: Recognized;
  readonly signal: NodeJS.Signals | null;
  readonly stderrBytes: number;
  readonly stdoutBytes: number | undefined;
}

export interface StopOptions {
  /**
   * The signal that asks the child to stop, or `null` to wait for it to exit
   * on its own, as an encoder does after its input ends.
   */
  readonly signal?: NodeJS.Signals | null;
  /** How long it may take before it is killed outright. */
  readonly graceMs?: number;
}

export interface SupervisedChild<P extends ChildLike> {
  /** The process, for the wrapper's protocol. */
  readonly process: P;
  /** Waits for the child to end. */
  readonly exit: Effect.Effect<ChildExit>;
  readonly running: () => boolean;
  /** Ends the child: signal it, give it its grace, then kill it. */
  readonly stop: (options?: StopOptions) => Effect.Effect<ChildExit>;
  /**
   * Signals the child without waiting, as a protocol does from a callback.
   * Its exit is then its owner's stop, not a failure.
   */
  readonly kill: (signal: NodeJS.Signals) => void;
  /** The typed failure for an exit, if the exit was one. */
  readonly failure: (
    exit: ChildExit,
    code?: ChildFailureCode
  ) => Option.Option<ChildProcessFailure>;
}

export interface SuperviseOptions {
  /** Reads codes from what the child printed, for the log and the failure. */
  readonly recognize?: ((output: ChildOutput) => Recognized) | undefined;
  /** How the owning scope ends the child. */
  readonly stop?: StopOptions;
  /**
   * Called once when the child ends, before anyone waiting on `exit` resumes.
   * It runs synchronously, so it may log or record but not wait.
   */
  readonly onExit?: (
    exit: ChildExit,
    failure: Option.Option<ChildProcessFailure>
  ) => Effect.Effect<void>;
  /** The stdout tail, when the module reads stdout itself. */
  readonly stdout?: ReturnType<typeof boundedTail>;
}

const describe = (child: string, code: ChildFailureCode) => {
  switch (code) {
    case "spawn_failed": {
      return `The ${child} process could not start.`;
    }
    case "exited": {
      return `The ${child} process exited with a failure.`;
    }
    case "signaled": {
      return `The ${child} process was stopped by a signal.`;
    }
    case "timed_out": {
      return `The ${child} process did not finish in time.`;
    }
    case "output_limit": {
      return `The ${child} process printed more than it may.`;
    }
    default: {
      return `The ${child} process failed.`;
    }
  }
};

const newFailure = (
  child: string,
  exit: ChildExit,
  code: ChildFailureCode,
  output: ChildOutput
) => {
  const failure = new ChildProcessFailure({
    child,
    code,
    durationMs: exit.durationMs,
    errno: exit.errno,
    exitCode: exit.exitCode,
    message: describe(child, code),
    recognized: exit.recognized,
    signal: exit.signal,
  });
  outputs.set(failure, output);
  return failure;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node rejects with whatever it threw; only its errno code is read.
const errnoOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "code") && Predicate.isString(error.code)
    ? error.code
    : undefined;

/**
 * A child's end, logged by its shape and closing its span. A clean exit is
 * Trace: some one-shots run every second, and the Diagnostic Log keeps Debug.
 */
const recordEnd = (
  child: string,
  span: Tracer.Span,
  exit: ChildExit,
  failure: Option.Option<ChildProcessFailure>
) =>
  Effect.gen(function* endChild() {
    const annotations = Object.fromEntries(
      Object.entries({
        child,
        code: exit.recognized.code,
        durationMs: exit.durationMs,
        errno: exit.errno,
        exitCode: exit.exitCode,
        outcome: exit.outcome,
        reason: exit.recognized.reason,
        signal: exit.signal,
        stderrBytes: exit.stderrBytes,
        stdoutBytes: exit.stdoutBytes,
      }).filter(([, value]) => value !== undefined && value !== null)
    );
    yield* Effect.logWithLevel(
      exit.outcome === "succeeded" ? "Trace" : "Debug"
    )("Child process ended").pipe(Effect.annotateLogs(annotations));
    span.attribute("outcome", exit.outcome);
    span.attribute("durationMs", exit.durationMs);
    if (exit.exitCode !== null) {
      span.attribute("exitCode", exit.exitCode);
    }
    span.end(
      yield* Clock.currentTimeNanos,
      Option.isSome(failure) ? Exit.fail(failure.value) : Exit.void
    );
  });

const isSignal = (value: unknown): value is NodeJS.Signals =>
  Predicate.isString(value) && value.startsWith("SIG");

/** What `runChild` needs beyond a wrapper's interface. */
interface Limits {
  /** The child printed past its ceiling; kill it. */
  readonly overflow: () => void;
  /** The child overstayed its timeout; the next stop names that. */
  readonly timeout: () => void;
}

const supervise = <P extends ChildLike>(
  child: string,
  start: () => P,
  options: SuperviseOptions
): Effect.Effect<
  { readonly supervised: SupervisedChild<P>; readonly limits: Limits },
  ChildProcessFailure,
  Scope.Scope
> =>
  Effect.gen(function* superviseProcess() {
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncExitWith(context);
    const span = yield* Effect.makeSpan("child.process", {
      attributes: { child },
    });
    const startedAt = yield* Clock.currentTimeMillis;
    const stderr = boundedTail();
    const exited = Deferred.makeUnsafe<ChildExit>();
    let stopping = false;
    let timedOut = false;
    let overflowed = false;
    let errno: string | undefined;

    const output = (): ChildOutput => ({
      stderr: stderr.text(),
      stdout: options.stdout?.text(),
    });
    const makeFailure = (exit: ChildExit, code: ChildFailureCode) =>
      newFailure(child, exit, code, output());
    const failureOf = (
      exit: ChildExit,
      code?: ChildFailureCode
    ): Option.Option<ChildProcessFailure> => {
      if (code !== undefined) {
        return Option.some(makeFailure(exit, code));
      }
      return exit.outcome === "succeeded" || exit.outcome === "stopped"
        ? Option.none()
        : Option.some(makeFailure(exit, exit.outcome));
    };
    const outcomeOf = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawned: boolean
    ): ChildOutcome => {
      if (!spawned) {
        return "spawn_failed";
      }
      if (overflowed) {
        return "output_limit";
      }
      if (timedOut) {
        return "timed_out";
      }
      if (exitCode === 0) {
        return "succeeded";
      }
      if (stopping) {
        return "stopped";
      }
      return signal === null ? "exited" : "signaled";
    };
    const settle = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawned: boolean
    ) => {
      if (Deferred.isDoneUnsafe(exited)) {
        return;
      }
      const ended = runSync(Clock.currentTimeMillis);
      const exit: ChildExit = {
        durationMs: Exit.isSuccess(ended) ? ended.value - startedAt : 0,
        errno,
        exitCode,
        outcome: outcomeOf(exitCode, signal, spawned),
        recognized: options.recognize?.(output()) ?? {},
        signal,
        stderrBytes: stderr.bytes(),
        stdoutBytes: options.stdout?.bytes(),
      };
      const failure = failureOf(exit);
      runSync(
        recordEnd(child, span, exit, failure).pipe(
          Effect.andThen(
            options.onExit === undefined
              ? Effect.void
              : options.onExit(exit, failure)
          )
        )
      );
      Deferred.doneUnsafe(exited, Effect.succeed(exit));
    };

    let started: P;
    try {
      started = start();
    } catch (error) {
      errno = errnoOf(error);
      settle(null, null, false);
      const exit = yield* Deferred.await(exited);
      return yield* Effect.fail(makeFailure(exit, "spawn_failed"));
    }
    started.stderr?.on("data", (chunk) => {
      stderr.push(chunk);
    });
    started.once("error", (error) => {
      errno ??= errnoOf(error);
      // A process that never started has no `close` to wait for.
      if (started.pid === undefined) {
        settle(null, null, false);
      }
    });
    started.once("close", (code, signal) => {
      settle(
        Predicate.isNumber(code) ? code : started.exitCode,
        isSignal(signal) ? signal : started.signalCode,
        errno === undefined || started.pid !== undefined
      );
    });

    const running = () =>
      !Deferred.isDoneUnsafe(exited) &&
      started.exitCode === null &&
      started.signalCode === null;
    const kill = (signal: NodeJS.Signals) => {
      try {
        started.kill(signal);
      } catch (error) {
        runSync(
          Effect.logDebug("Could not signal a child process", {
            child,
            errno: errnoOf(error),
            signal,
          })
        );
      }
    };
    // A child whose descendants hold its pipes open never closes them, so a
    // killed child settles from its own exit after one more grace period.
    const awaitKilled = (graceMs: number) =>
      Deferred.await(exited).pipe(
        Effect.timeoutOrElse({
          duration: graceMs,
          orElse: () =>
            Effect.sync(() => {
              settle(started.exitCode, started.signalCode, true);
            }).pipe(Effect.andThen(Deferred.await(exited))),
        })
      );
    const stop = (stopOptions: StopOptions = {}) =>
      Effect.gen(function* stopChild() {
        if (Deferred.isDoneUnsafe(exited)) {
          return yield* Deferred.await(exited);
        }
        // Exited, but its pipes have not closed: it is over all the same.
        if (!running()) {
          settle(started.exitCode, started.signalCode, true);
          return yield* Deferred.await(exited);
        }
        const { graceMs = STOP_GRACE_MS, signal = "SIGTERM" } = {
          ...options.stop,
          ...stopOptions,
        };
        // Waiting without a signal leaves the child's own exit its own: an
        // encoder that fails while it flushes still fails.
        if (signal !== null && running()) {
          stopping = true;
          kill(signal);
        }
        return yield* Deferred.await(exited).pipe(
          Effect.timeoutOrElse({
            duration: graceMs,
            orElse: () =>
              Effect.sync(() => {
                stopping = true;
                kill("SIGKILL");
              }).pipe(Effect.andThen(awaitKilled(graceMs))),
          })
        );
      });
    yield* Effect.addFinalizer(() => stop().pipe(Effect.asVoid));

    return {
      limits: {
        overflow: () => {
          overflowed = true;
          kill("SIGKILL");
        },
        timeout: () => {
          timedOut = true;
        },
      },
      supervised: {
        exit: Deferred.await(exited),
        failure: failureOf,
        kill: (signal: NodeJS.Signals) => {
          if (running()) {
            stopping = true;
            kill(signal);
          }
        },
        process: started,
        running,
        stop,
      },
    };
  });

/**
 * Supervises a process `start` launches. The scope owns it: closing the
 * scope stops it.
 */
export const superviseChild = <P extends ChildLike>(
  child: string,
  start: () => P,
  options: SuperviseOptions = {}
): Effect.Effect<SupervisedChild<P>, ChildProcessFailure, Scope.Scope> =>
  supervise(child, start, options).pipe(
    Effect.map(({ supervised }) => supervised)
  );

/** Starts a process for `superviseChild`. Only this module calls Node's spawn. */
export const spawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcess => spawn(command, [...args], options);

/** Starts a process with every stream piped, for a protocol over all three. */
export const spawnPiped = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {}
): ChildProcessWithoutNullStreams =>
  spawn(command, [...args], { ...options, stdio: "pipe" });

/** Starts and supervises a process. */
export const spawnChild = (
  child: string,
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  options: SuperviseOptions = {}
) =>
  superviseChild(
    child,
    () => spawnProcess(command, args, spawnOptions),
    options
  );

export interface RunChildOptions {
  readonly child: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Set, never inherited ([ADR 0021](../../../../docs/adr/0021-timeouts-are-set-not-inherited.md)). */
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly maxOutputBytes?: number;
  readonly recognize?: ((output: ChildOutput) => Recognized) | undefined;
  /**
   * A non-zero exit is an answer, not a failure, as `ps` gives for a process
   * that is gone. Signals, timeouts, and failures to start still fail.
   */
  readonly exitCodeIsAnswer?: boolean;
}

/**
 * Runs a process to completion and returns its stdout. A non-zero exit, a
 * signal, the timeout, or too much output fails with `ChildProcessFailure`.
 */
export const runChild = (
  options: RunChildOptions
): Effect.Effect<Buffer, ChildProcessFailure> =>
  Effect.scoped(
    Effect.gen(function* runToCompletion() {
      const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      const stdoutTail = boundedTail();
      const chunks: Buffer[] = [];
      const { limits, supervised } = yield* supervise(
        options.child,
        () =>
          spawnProcess(options.command, options.args, {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        {
          recognize: options.recognize,
          stdout: stdoutTail,
          stop: { graceMs: 2000 },
        }
      );
      supervised.process.stdout?.on("data", (chunk: Buffer) => {
        stdoutTail.push(chunk);
        if (stdoutTail.bytes() > maxOutputBytes) {
          limits.overflow();
          return;
        }
        chunks.push(chunk);
      });
      const exit = yield* supervised.exit.pipe(
        Effect.timeoutOrElse({
          duration: options.timeoutMs,
          orElse: () =>
            Effect.sync(limits.timeout).pipe(Effect.andThen(supervised.stop())),
        })
      );
      const failure =
        options.exitCodeIsAnswer === true && exit.outcome === "exited"
          ? Option.none()
          : supervised.failure(exit);
      if (Option.isSome(failure)) {
        return yield* Effect.fail(failure.value);
      }
      return Buffer.concat(chunks);
    })
  );

/** `runChild`'s stdout as trimmed text. */
export const runChildText = (options: RunChildOptions) =>
  runChild(options).pipe(
    Effect.map((stdout) => stdout.toString("utf-8").trim())
  );

/** Drains a stderr stream to its end, keeping only its last `limit` bytes. */
export const collectTail =
  (limit = CHILD_TAIL_BYTES) =>
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
    Effect.suspend(() => {
      const tail = boundedTail(limit);
      return stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            tail.push(Buffer.from(chunk));
          })
        ),
        Effect.as(tail)
      );
    });

export interface SupervisedHandle {
  /** The process, for the wrapper's protocol. Its stderr is the module's. */
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  /** The stderr tail once stderr closes, or why it could not be read. */
  readonly stderr: Effect.Effect<string>;
}

/**
 * Starts and supervises a command through Effect's spawner, for a wrapper
 * whose protocol is Effect streams, such as the code interpreter's. The
 * spawner's scope owns the kill; this adds the span, the record, and the
 * stderr tail.
 */
export const spawnHandle = (
  child: string,
  command: ChildProcessCommand.Command,
  options: { readonly tailBytes?: number } = {}
): Effect.Effect<
  SupervisedHandle,
  ChildProcessFailure,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* superviseHandle() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const span = yield* Effect.makeSpan("child.process", {
      attributes: { child },
    });
    const startedAt = yield* Clock.currentTimeMillis;
    const exitOf = (
      outcome: ChildOutcome,
      exitCode: number | null,
      stderrBytes: number
    ) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now): ChildExit => ({
          durationMs: now - startedAt,
          errno: undefined,
          exitCode,
          outcome,
          recognized: {},
          signal: null,
          stderrBytes,
          stdoutBytes: undefined,
        }))
      );
    const spawned = yield* Effect.result(spawner.spawn(command));
    if (spawned._tag === "Failure") {
      const exit = yield* exitOf("spawn_failed", null, 0);
      const failure = newFailure(child, exit, "spawn_failed", { stderr: "" });
      yield* recordEnd(child, span, exit, Option.some(failure));
      return yield* Effect.fail(failure);
    }
    const handle = spawned.success;
    const tail = boundedTail(options.tailBytes);
    const drain = yield* handle.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          tail.push(Buffer.from(chunk));
        })
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
      Effect.forkScoped
    );
    // The exit code, once the process exits. A signal fails `exitCode`.
    const exited = yield* Deferred.make<number | null>();
    yield* handle.exitCode.pipe(
      Effect.result,
      Effect.flatMap((code) =>
        Deferred.succeed(
          exited,
          code._tag === "Success" ? Number(code.success) : null
        )
      ),
      Effect.forkScoped
    );
    let stopping = false;
    // One record per process, whatever ends it: added last, this runs first
    // when the scope closes, before the spawner kills a process still running.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* recordHandleEnd() {
        // A process that has exited has a code its watcher is about to hand
        // over; one still running has none, and the spawner stops it next.
        const running = yield* handle.isRunning.pipe(
          Effect.orElseSucceed(() => false)
        );
        const known = running
          ? Option.none<number | null>()
          : Option.some(yield* Deferred.await(exited));
        const exitCode = Option.getOrNull(known);
        let outcome: ChildOutcome = "stopped";
        if (Option.isSome(known)) {
          if (exitCode === 0) {
            outcome = "succeeded";
          } else if (!stopping) {
            outcome = exitCode === null ? "signaled" : "exited";
          }
        }
        const exit = yield* exitOf(outcome, exitCode, tail.bytes());
        yield* recordEnd(
          child,
          span,
          exit,
          outcome === "exited" || outcome === "signaled"
            ? Option.some(
                newFailure(child, exit, outcome, { stderr: tail.text() })
              )
            : Option.none()
        );
      })
    );
    return {
      // A kill through the handle is its owner's stop, not a failure.
      handle: ChildProcessSpawner.makeHandle({
        ...handle,
        kill: (killOptions) =>
          Effect.sync(() => {
            stopping = true;
          }).pipe(Effect.andThen(handle.kill(killOptions))),
      }),
      stderr: Fiber.join(drain).pipe(
        Effect.map((complete) =>
          complete
            ? tail.text()
            : "Diagnostics incomplete: stderr stream failed."
        )
      ),
    };
  });

/**
 * The output tails of every failed child a recorded cause names, for the
 * Workspace's debug detail. Never logged.
 */
export const childOutputsOf = (
  cause: Cause.Cause<unknown>
): readonly { readonly child: string; readonly output: ChildOutput }[] => {
  const found: { child: string; output: ChildOutput }[] = [];
  const seen = new Set<unknown>();
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A cause holds any value; only ChildProcessFailures are read.
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !Predicate.isObject(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof ChildProcessFailure) {
      const output = outputs.get(value);
      if (output !== undefined) {
        found.push({ child: value.child, output });
      }
    }
    if (Predicate.hasProperty(value, "cause")) {
      visit(value.cause, depth + 1);
    }
    Option.map(droppedCause(value), (dropped) => visit(dropped, depth + 1));
  };
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      visit(reason.error, 0);
    } else if (Cause.isDieReason(reason)) {
      visit(reason.defect, 0);
    }
  }
  return found;
};
