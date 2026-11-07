import { expect, test } from "vitest";

import type { InterpreterOutcome } from "../../src/services/code-interpreter.ts";
import { compactInterpreterOutcome } from "../../src/services/mcp-code-interpreter.ts";

const process = {
  bytesFromInterpreter: 100,
  bytesToInterpreter: 100,
  durationMs: 1500,
  exit: "signal SIGKILL",
  heapLimitBytes: 100,
  lastMemory: { arrayBuffersBytes: 0, heapUsedBytes: 99, rssBytes: 200 },
  peakRssBytes: 200,
  pid: 123,
  rssCeilingBytes: 200,
  startupMs: 5,
};

test("omits process and successful receipts while retaining intervention and uncertain dispatch identity", () => {
  const outcome: InterpreterOutcome = {
    intervention: { reasons: ["takeover"] },
    process,
    receipts: [
      {
        operation: "read",
        operationId: null,
        outcome: "succeeded",
        sequence: 1,
      },
    ],
    status: "intervention",
  };
  expect(compactInterpreterOutcome(outcome, 1000)).toEqual({
    status: "intervention",
  });
  expect(
    compactInterpreterOutcome(
      { ...outcome, status: "completed", value: 42 },
      1000
    )
  ).toEqual({ status: "completed", value: 42 });
  const uncertain = {
    message: "Inspect the session",
    operation: "act",
    operationId: "op1",
    outcome: "uncertain" as const,
    sequence: 2,
  };
  expect(
    compactInterpreterOutcome(
      { ...outcome, receipts: [...outcome.receipts, uncertain] },
      1000
    )
  ).toEqual({ receipts: [uncertain], status: "intervention" });
});

test("includes relevant one-line memory, crash, and deadline process facts", () => {
  for (const [status, message] of [
    ["memory_limit", "Heap 99/100; RSS 200/200 bytes."],
    ["crashed", "Process exit: signal SIGKILL."],
    ["deadline_exceeded", "Elapsed 1500 ms; deadline 1000 ms."],
  ] as const) {
    expect(
      compactInterpreterOutcome({ process, receipts: [], status }, 1000)
    ).toEqual({ diagnostic: { kind: status, message }, status });
  }
});

test("renders absent memory readings as unknown", () => {
  expect(
    compactInterpreterOutcome(
      {
        process: {
          ...process,
          heapLimitBytes: null,
          lastMemory: null,
          peakRssBytes: null,
        },
        receipts: [],
        status: "memory_limit",
      },
      1000
    )
  ).toEqual({
    diagnostic: {
      kind: "memory_limit",
      message: "Heap unknown/unknown; RSS unknown/200 bytes.",
    },
    status: "memory_limit",
  });
});
