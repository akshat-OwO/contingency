import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  References,
  Scope,
} from "effect";
import { ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";

import {
  CHILD_TAIL_BYTES,
  ChildProcessFailure,
  childOutput,
  childOutputsOf,
  runChild,
  spawnChild,
  spawnHandle,
} from "../../src/services/child-process.ts";
import type { ChildExit } from "../../src/services/child-process.ts";
import { toSafeRecord } from "../../src/services/diagnostic-log.ts";
import type { SafeRecord } from "../../src/services/diagnostic-log.ts";

const SECRET = "hunter2";
const FIXTURE = fileURLToPath(
  new URL("../fixtures/child-process/child.mjs", import.meta.url)
);
/** A generous guard for a hung child; never how long the work takes. */
const HANG_GUARD = "30 seconds";

/** Runs an effect collecting what the Diagnostic Log would keep. */
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const records: SafeRecord[] = [];
  const logger = Logger.make((event) => {
    records.push(toSafeRecord(event, ""));
  });
  return effect.pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Trace"),
    Effect.map((value) => ({ records, value }))
  );
};

const fixture = (...args: string[]) => ({
  args: [FIXTURE, ...args],
  child: "fixture",
  command: process.execPath,
  timeoutMs: 30_000,
});

const ended = (records: readonly SafeRecord[]) =>
  records.filter((record) => record.message === "Child process ended");

const field = (record: SafeRecord | undefined, key: string) =>
  record?.fields.find(([name]) => name === key)?.[1];

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts a fixture that prints `ready <pid>`, and waits for that line. */
const started = (mode: "hang" | "stubborn") =>
  Effect.gen(function* startFixture() {
    const child = yield* spawnChild(
      "fixture",
      process.execPath,
      [FIXTURE, mode],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const pid = yield* Effect.callback<number>((resume) => {
      let output = "";
      child.process.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
        const ready = /ready (?<pid>\d+)\n/u.exec(output);
        if (ready?.groups?.pid !== undefined) {
          resume(Effect.succeed(Number(ready.groups.pid)));
        }
      });
    }).pipe(Effect.timeout(HANG_GUARD));
    return { child, pid };
  });

describe("a child that runs to completion", () => {
  it.effect("returns its stdout and logs one record by its shape", () =>
    Effect.gen(function* succeeded() {
      const { records, value } = yield* observed(
        runChild(fixture("write", "0"))
      );
      expect(value.toString("utf-8")).toContain("stdout says");
      const [record] = ended(records);
      expect(ended(records)).toHaveLength(1);
      // A clean exit sits below what the Diagnostic Log keeps.
      expect(record?.level).toBe("Trace");
      expect(field(record, "child")).toBe("fixture");
      expect(field(record, "outcome")).toBe("succeeded");
      expect(field(record, "exitCode")).toBe("0");
      expect(Number(field(record, "stderrBytes"))).toBeGreaterThan(0);
      expect(Number(field(record, "stdoutBytes"))).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain(SECRET);
    })
  );

  it.effect(
    "fails with its exit code, keeping its output off the log and on the failure",
    () =>
      Effect.gen(function* failed() {
        const { records, value: failure } = yield* observed(
          Effect.flip(runChild(fixture("write", "3")))
        );
        expect(failure).toBeInstanceOf(ChildProcessFailure);
        expect(failure).toMatchObject({
          child: "fixture",
          code: "exited",
          exitCode: 3,
          signal: null,
        });
        expect(failure.message).not.toContain(SECRET);
        expect(JSON.stringify(failure)).not.toContain(SECRET);
        expect(ended(records)[0]?.level).toBe("Debug");
        expect(field(ended(records)[0], "outcome")).toBe("exited");
        expect(field(ended(records)[0], "exitCode")).toBe("3");
        expect(JSON.stringify(records)).not.toContain(SECRET);
        const output = Option.getOrUndefined(childOutput(failure));
        expect(output?.stderr).toContain(`stderr says ${SECRET}`);
        expect(output?.stdout).toContain(`stdout says ${SECRET}`);
      })
  );

  it.effect("keeps only a bounded tail of what it printed", () =>
    Effect.gen(function* chatty() {
      const { records, value: failure } = yield* observed(
        Effect.flip(runChild(fixture("chatty")))
      );
      const stderr = Option.getOrUndefined(childOutput(failure))?.stderr ?? "";
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(CHILD_TAIL_BYTES);
      expect(stderr).toContain(`line ${"1023".padStart(14, "0")}`);
      expect(stderr).not.toContain(`line ${"0".padStart(14, "0")}`);
      expect(field(ended(records)[0], "stderrBytes")).toBe(String(1024 * 20));
    })
  );

  it.effect("names a recognized code in the record and the failure", () =>
    Effect.gen(function* recognized() {
      const { records, value: failure } = yield* observed(
        Effect.flip(
          runChild({
            ...fixture("write", "1"),
            recognize: ({ stderr }) =>
              stderr.includes("stderr says")
                ? { code: "SAID_SOMETHING", reason: "on_stderr" }
                : {},
          })
        )
      );
      expect(failure.recognized).toEqual({
        code: "SAID_SOMETHING",
        reason: "on_stderr",
      });
      expect(field(ended(records)[0], "code")).toBe("SAID_SOMETHING");
      expect(field(ended(records)[0], "reason")).toBe("on_stderr");
    })
  );

  it.effect("fails to start with the errno and no output", () =>
    Effect.gen(function* missing() {
      const { records, value: failure } = yield* observed(
        Effect.flip(
          runChild({
            args: [],
            child: "missing",
            command: "/nonexistent/contingency-child",
            timeoutMs: 30_000,
          })
        )
      );
      expect(failure).toMatchObject({ code: "spawn_failed", errno: "ENOENT" });
      expect(field(ended(records)[0], "outcome")).toBe("spawn_failed");
      expect(field(ended(records)[0], "errno")).toBe("ENOENT");
    })
  );

  it.effect("kills a child that prints past its ceiling", () =>
    Effect.gen(function* flood() {
      const failure = yield* Effect.flip(
        runChild({ ...fixture("flood"), maxOutputBytes: 256 * 1024 })
      ).pipe(Effect.timeout(HANG_GUARD));
      expect(failure).toMatchObject({
        code: "output_limit",
        signal: "SIGKILL",
      });
    })
  );

  it.effect("kills a child that overstays its timeout", () =>
    Effect.gen(function* overstays() {
      const running = yield* Effect.forkChild(
        Effect.flip(runChild({ ...fixture("hang"), timeoutMs: 1000 }))
      );
      // it.effect supplies TestClock, so the timeout fires when it moves.
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(running).pipe(
        Effect.timeout(HANG_GUARD)
      );
      expect(failure).toMatchObject({ code: "timed_out", signal: "SIGTERM" });
    })
  );
});

describe("a child its scope owns", () => {
  it.effect("is stopped when its scope closes, and logs the stop", () =>
    Effect.gen(function* owned() {
      const scope = yield* Scope.make();
      const { records, value } = yield* observed(
        started("hang").pipe(Scope.provide(scope))
      );
      expect(isAlive(value.pid)).toBe(true);
      yield* Scope.close(scope, Exit.void).pipe(Effect.timeout(HANG_GUARD));
      const exit: ChildExit = yield* value.child.exit;
      expect(exit).toMatchObject({ outcome: "stopped", signal: "SIGTERM" });
      expect(isAlive(value.pid)).toBe(false);
      expect(Option.isNone(value.child.failure(exit))).toBe(true);
      expect(field(ended(records)[0], "outcome")).toBe("stopped");
    })
  );

  it.effect("is killed outright when it ignores the stop signal", () =>
    Effect.gen(function* stubborn() {
      const scope = yield* Scope.make();
      const { pid, child } = yield* started("stubborn").pipe(
        Scope.provide(scope)
      );
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      // it.effect supplies TestClock, so the stop's grace ends when it moves.
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(closing).pipe(Effect.timeout(HANG_GUARD));
      expect(yield* child.exit).toMatchObject({
        outcome: "stopped",
        signal: "SIGKILL",
      });
      expect(isAlive(pid)).toBe(false);
    })
  );

  it.effect("reports a child that dies on its own as a failure", () =>
    Effect.gen(function* dies() {
      const { child, pid } = yield* started("hang");
      process.kill(pid, "SIGKILL");
      const exit = yield* child.exit.pipe(Effect.timeout(HANG_GUARD));
      expect(exit.outcome).toBe("signaled");
      expect(Option.getOrUndefined(child.failure(exit))).toMatchObject({
        code: "signaled",
        signal: "SIGKILL",
      });
    }).pipe(Effect.scoped)
  );
});

describe("a child started through Effect's spawner", () => {
  const handleOf = (...args: string[]) =>
    spawnHandle(
      "fixture",
      ChildProcess.make(process.execPath, [FIXTURE, ...args])
    );

  it.effect("logs one record when it exits on its own", () =>
    Effect.gen(function* exits() {
      const { records } = yield* observed(
        Effect.gen(function* waitForExit() {
          const { handle, stderr } = yield* handleOf("write", "4");
          yield* handle.exitCode.pipe(
            Effect.ignore({ log: "Debug", message: "x" })
          );
          expect(yield* stderr).toContain(SECRET);
        }).pipe(Effect.scoped)
      );
      expect(ended(records)).toHaveLength(1);
      expect(field(ended(records)[0], "outcome")).toBe("exited");
      expect(field(ended(records)[0], "exitCode")).toBe("4");
      expect(JSON.stringify(records)).not.toContain(SECRET);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("names a kill through the handle as its owner's stop", () =>
    Effect.gen(function* killed() {
      const { records } = yield* observed(
        Effect.gen(function* killHandle() {
          const { handle } = yield* handleOf("hang");
          yield* handle.kill({ killSignal: "SIGKILL" });
          yield* Effect.result(handle.exitCode);
        }).pipe(Effect.scoped)
      );
      expect(ended(records)).toHaveLength(1);
      expect(field(ended(records)[0], "outcome")).toBe("stopped");
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("names a process its scope ends as stopped", () =>
    Effect.gen(function* scopeEnds() {
      const { records } = yield* observed(handleOf("hang").pipe(Effect.scoped));
      expect(ended(records)).toHaveLength(1);
      expect(field(ended(records)[0], "outcome")).toBe("stopped");
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("a recorded cause", () => {
  it.effect("names the output of each failed child it holds", () =>
    Effect.gen(function* named() {
      const failure = yield* Effect.flip(runChild(fixture("write", "2")));
      const wrapped = { _tag: "WrapperError", cause: failure, code: "x" };
      const [found] = childOutputsOf(Cause.fail(wrapped));
      expect(found?.child).toBe("fixture");
      expect(found?.output.stderr).toContain(SECRET);
    })
  );
});
