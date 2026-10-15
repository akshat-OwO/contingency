import v8 from "node:v8";
import { Worker } from "node:worker_threads";

import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { Deferred, Effect, Schema, Stdio, Stream } from "effect";
import type { Types } from "effect";

import {
  ServerMessage,
  WatchdogOptions,
  encodeLine,
  strictDecode,
} from "./code-interpreter-protocol.ts";
import type {
  DoneMessage,
  ExecuteMessage,
  InterpreterReport,
  MemoryReading,
  OperationResultMessage,
} from "./code-interpreter-protocol.ts";

/**
 * The OpenCode interpreter process (ADR 0059, #459). It runs exactly one
 * program and exits, so no program state survives into the next execution.
 * Every operation the program calls is a request to the server, which owns
 * validation, authority, dispatch, and receipts; this process only runs code.
 *
 * argv[2] carries the watchdog options as JSON.
 */

/**
 * Runs on its own thread, so it keeps sampling while the interpreter thread
 * is blocked inside one native call such as a backtracking regular
 * expression. The V8 heap ceiling cannot see ArrayBuffer memory; this does.
 * It also ends the process when the server that spawned it has gone.
 */
const WATCHDOG = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const write = (message) => {
  try {
    fs.writeSync(3, JSON.stringify(message) + "\\n");
  } catch {}
};
const memory = () => {
  const usage = process.memoryUsage();
  return { arrayBuffersBytes: usage.arrayBuffers, heapUsedBytes: usage.heapUsed, rssBytes: usage.rss };
};
let ticks = 0;
setInterval(() => {
  if (process.ppid !== workerData.parentPid) {
    write({ type: "orphaned" });
    process.kill(process.pid, "SIGKILL");
  }
  const rss = process.memoryUsage.rss();
  if (rss > workerData.rssCeilingBytes) {
    write({ memory: memory(), type: "rss_ceiling" });
    process.kill(process.pid, "SIGKILL");
  }
  ticks += 1;
  if (ticks % 20 === 0) {
    write({ memory: memory(), type: "sample" });
  }
}, workerData.intervalMs);
`;

const memoryUsage = (): MemoryReading => {
  const usage = process.memoryUsage();
  return {
    arrayBuffersBytes: usage.arrayBuffers,
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
  };
};

/** Resolves once the line is handed to the pipe, so an exit cannot drop it. */
const send = (message: InterpreterReport) =>
  Effect.callback<boolean>((resume) => {
    process.stdout.write(encodeLine(message), (writeFailure) => {
      resume(
        Effect.succeed(writeFailure === undefined || writeFailure === null)
      );
    });
  });

const decodeInput = Schema.decodeUnknownEffect(Schema.Json);

const decodeServerMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerMessage),
  strictDecode
);

const exit = (code: number) =>
  Effect.sync(() => {
    process.exit(code);
  });

const main = Effect.gen(function* interpreterProcess() {
  const stdio = yield* Stdio.Stdio;
  const [watchdogArgument] = yield* stdio.args;
  const watchdog = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(WatchdogOptions),
    strictDecode
  )(watchdogArgument);
  new Worker(WATCHDOG, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2 },
    workerData: { ...watchdog, parentPid: process.ppid },
  }).unref();

  const program = yield* Deferred.make<typeof ExecuteMessage.Type>();
  const pending = new Map<
    number,
    Deferred.Deferred<typeof OperationResultMessage.Type>
  >();
  const cancelled = yield* Deferred.make<"cancelled" | "intervention">();

  // Every line must decode strictly. A server that sends anything else has
  // broken the protocol, and this process stops rather than guess.
  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* handleLine() {
        const message = yield* decodeServerMessage(line);
        switch (message.type) {
          case "execute": {
            yield* Deferred.succeed(program, message);
            return;
          }
          case "result": {
            const waiting = pending.get(message.id);
            if (waiting === undefined) {
              return yield* Effect.die(
                new Error(`No request ${message.id} is waiting.`)
              );
            }
            pending.delete(message.id);
            yield* Deferred.succeed(waiting, message);
            return;
          }
          case "cancel": {
            yield* Deferred.succeed(cancelled, message.reason);
            return;
          }
          default: {
            return yield* Effect.die(new Error("Unknown server message."));
          }
        }
      })
    ),
    // The server is gone or broke the protocol: nothing can answer a request.
    Effect.ignoreCause,
    Effect.andThen(exit(2)),
    Effect.forkDetach
  );

  yield* send({
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    type: "ready",
  });
  const execute = yield* Deferred.await(program);

  let nextId = 0;
  const request = (operation: string, input: Schema.Json) =>
    Effect.gen(function* requestOperation() {
      nextId += 1;
      const id = nextId;
      const answer = yield* Deferred.make<typeof OperationResultMessage.Type>();
      pending.set(id, answer);
      yield* send({ id, input, operation, type: "call" });
      const { outcome } = yield* Deferred.await(answer);
      if (!outcome.ok) {
        return yield* Effect.fail(toolError(outcome.message));
      }
      return outcome.value;
    });

  const tools = Object.fromEntries(
    execute.operations.map((operation) => [
      operation.name,
      Tool.make({
        description: operation.description,
        // CodeMode copies program values across its plain-data boundary, so
        // this only confirms what it guarantees.
        execute: (input) =>
          decodeInput(input).pipe(
            Effect.mapError(() => toolError("Operation input must be JSON.")),
            Effect.flatMap((json) => request(operation.name, json))
          ),
        // SAFETY: the server renders this from the operation's own schema.
        // CodeMode only uses it to print a signature, and a program that
        // never searches is sent none.
        input: (operation.inputSchema ?? {}) as Tool.JsonSchema,
        output: {},
      }),
    ])
  );

  // A cancel interrupts the program; the server kills the process regardless.
  const ending = yield* Effect.raceFirst(
    CodeMode.execute({
      code: execute.code,
      limits: execute.limits,
      tools,
    }).pipe(Effect.map((result) => ({ _tag: "finished" as const, result }))),
    Deferred.await(cancelled).pipe(Effect.as({ _tag: "cancelled" as const }))
  );
  if (ending._tag === "cancelled") {
    return yield* exit(0);
  }
  const finished = ending.result;
  const done: Types.Mutable<typeof DoneMessage.Type> = {
    memory: memoryUsage(),
    ok: finished.ok,
    type: "done",
  };
  if (finished.ok) {
    done.value = finished.value;
  } else {
    done.error = { kind: finished.error.kind, message: finished.error.message };
  }
  if (finished.logs !== undefined) {
    done.logs = finished.logs;
  }
  if (finished.truncated !== undefined) {
    done.truncated = finished.truncated;
  }
  yield* send(done);
  return yield* exit(0);
});

main.pipe(
  Effect.catchCause(() => exit(3)),
  Effect.provide(NodeStdio.layer),
  NodeRuntime.runMain
);
