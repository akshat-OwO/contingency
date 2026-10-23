import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { localSystemOneError } from "./local-system-one.ts";

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
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeDirectory(path.dirname(root), { recursive: true })
    )
  ).pipe(
    Effect.mapError(localSystemOneError),
    Effect.provide(NodeFileSystem.layer)
  );
