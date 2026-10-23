import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { localSystemOneOutput } from "./local-system-one-process.ts";
import {
  LocalSystemOneError,
  localSystemOneError,
} from "./local-system-one.ts";

const LOCK_PROGRAM = `import fcntl,sys
with open(sys.argv[1], "a") as lock:
 fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if sys.argv[2] == "try" else 0))
 print("locked", flush=True)
 sys.stdin.buffer.read()
`;

/** Kernel-owned lock. Closing stdin, parent death, and SIGKILL all release it. */
export const withLocalSystemOneLock = <A, E, R>(
  python: string,
  file: string,
  body: Effect.Effect<A, E, R>,
  nonBlocking = false
) =>
  Effect.gen(function* advisoryLock() {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(
          python,
          ["-I", "-c", LOCK_PROGRAM, file, nonBlocking ? "try" : "wait"],
          { stdio: ["pipe", "pipe", "pipe"] }
        )
      ),
      (process) =>
        Effect.promise(async () => {
          if (process.exitCode !== null || process.signalCode !== null) {
            return;
          }
          const exited = once(process, "close");
          process.stdin.end();
          // An acquisition interrupted while blocked must also terminate the helper.
          if (process.exitCode === null && process.signalCode === null) {
            process.kill("SIGTERM");
          }
          await exited;
        })
    );
    yield* Effect.raceFirst(
      Effect.tryPromise({
        catch: localSystemOneError,
        try: (signal) => once(child.stdout, "data", { signal }),
      }),
      Effect.tryPromise({
        catch: localSystemOneError,
        try: (signal) => once(child, "exit", { signal }),
      }).pipe(
        Effect.andThen(
          Effect.fail(
            localSystemOneError(
              `Local System One lock is held or unavailable: ${file}`
            )
          )
        )
      )
    );
    return yield* Effect.raceFirst(
      body,
      Effect.tryPromise({
        catch: localSystemOneError,
        try: (signal) => once(child, "exit", { signal }),
      }).pipe(
        Effect.andThen(
          Effect.fail(
            localSystemOneError(`Local System One lost its lock: ${file}`)
          )
        )
      )
    );
  }).pipe(Effect.scoped);

export const prepareLocalSystemOneLock = (root: string) =>
  Effect.tryPromise({
    catch: localSystemOneError,
    try: () => mkdir(path.dirname(root), { recursive: true }),
  });

/** Slice 1 left no owner record. Reclaim its empty directory only without an installer. */
export const recoverLegacyLocalSystemOneLock = (
  root: string,
  mutations = localSystemOneOutput("ps", ["-axo", "pid=,args="])
) =>
  Effect.gen(function* recoverLegacyLock() {
    const legacy = `${root}.lock`;
    const stat = yield* Effect.tryPromise({
      catch: localSystemOneError,
      try: async () => {
        try {
          return await lstat(legacy);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return;
          }
          throw error;
        }
      },
    });
    if (stat === undefined || !stat.isDirectory()) {
      return;
    }
    const processes = yield* mutations;
    for (const line of processes.split("\n")) {
      const [pid, executable] = line.trim().split(/\s+/u);
      if (
        Number(pid) !== process.pid &&
        executable !== undefined &&
        path.basename(executable) === "node" &&
        /system-one (?:setup|remove)(?:\s|$)/u.test(line)
      ) {
        return yield* new LocalSystemOneError({
          message: `Legacy Local System One mutation lock may be held by PID ${pid}. Wait for that command to finish.`,
        });
      }
    }
    yield* Effect.tryPromise({
      catch: localSystemOneError,
      try: () => rmdir(legacy),
    });
  });
