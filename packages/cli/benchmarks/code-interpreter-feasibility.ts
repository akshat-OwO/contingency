import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";

import {
  INTERPRETER_LIMITS,
  runInterpreterProgram,
} from "../src/services/code-interpreter.ts";
import type { InterpreterRunOptions } from "../src/services/code-interpreter.ts";

/**
 * Evidence for the OpenCode interpreter feasibility report (#459). Runs each
 * scenario against the built interpreter entry, the one the package ships,
 * and prints one JSON line per scenario. Build first with `nub run build`.
 * Pass `--long-wait` to add a 45-second server-side operation wait.
 */

const entry = path.resolve(
  import.meta.dirname,
  "../dist/code-interpreter-process.js"
);
const operations = [
  {
    description: "Waits on the server for the given milliseconds.",
    inputSchema: {
      properties: { ms: { type: "number" } },
      required: ["ms"],
      type: "object",
    },
    name: "wait",
  },
];
const decodeWait = Schema.decodeUnknownOption(
  Schema.Struct({ ms: Schema.Number })
);

const run = (
  scenario: string,
  options: Pick<InterpreterRunOptions, "code" | "timeoutMs"> &
    Partial<InterpreterRunOptions>
) =>
  runInterpreterProgram({
    dispatch: (_operation, input) =>
      Effect.sleep(
        Option.match(decodeWait(input), {
          onNone: () => 0,
          onSome: ({ ms }) => ms,
        })
      ).pipe(Effect.as({ ok: true as const, value: "waited" })),
    entry,
    operations,
    ...options,
  }).pipe(
    Effect.flatMap((outcome) =>
      Console.log(
        JSON.stringify({
          diagnostic: outcome.diagnostic,
          receipts: outcome.receipts.length,
          scenario,
          status: outcome.status,
          value: outcome.value,
          ...outcome.process,
        })
      )
    )
  );

const allocate = (count: number) =>
  `const kept = []; for (let i = 0; i < ${count}; i++) { kept.push(new Array(1000000).fill(i)) } return kept.length`;

const main = Effect.gen(function* feasibility() {
  yield* Console.log(
    JSON.stringify({
      arch: process.arch,
      limits: INTERPRETER_LIMITS,
      node: process.version,
      platform: process.platform,
    })
  );
  for (let index = 0; index < 10; index += 1) {
    yield* run(`round-trip-${index}`, {
      code: "return await tools.wait({ ms: 0 })",
      timeoutMs: 5000,
    });
  }
  yield* run("heap-ceiling", { code: allocate(40), timeoutMs: 30_000 });
  yield* run("heap-control", {
    code: allocate(40),
    limits: { heapOldSpaceMiB: 4096, rssCeilingBytes: 8 * 1024 ** 3 },
    timeoutMs: 30_000,
  });
  yield* run("rss-ceiling", {
    code: "const kept = []; for (let i = 0; i < 200; i++) { kept.push(new Uint8Array(9000000).fill(1)) } return kept.length",
    timeoutMs: 30_000,
  });
  yield* run("rss-control", {
    code: "const kept = []; for (let i = 0; i < 60; i++) { kept.push(new Uint8Array(9000000).fill(1)) } return kept.length",
    limits: { rssCeilingBytes: 8 * 1024 ** 3 },
    timeoutMs: 30_000,
  });
  yield* run("blocked-interpreter", {
    code: "return /^(a+)+$/.test('a'.repeat(40) + 'b')",
    timeoutMs: 2000,
  });
  yield* run("busy-loop", { code: "while (true) {}", timeoutMs: 2000 });
  if (process.argv.includes("--long-wait")) {
    yield* run("long-wait", {
      code: "return await tools.wait({ ms: 45000 })",
      timeoutMs: 60_000,
    });
  }
});

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
