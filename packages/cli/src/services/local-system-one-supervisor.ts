import { once } from "node:events";
import http from "node:http";
import path from "node:path";

import { Clock, Effect, FileSystem, Schedule, Schema, Sink } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeLocalSystemOneIdle } from "./local-system-one-idle.ts";
import { localSystemOneEnvironment } from "./local-system-one-live.ts";
import { withLocalSystemOneLock } from "./local-system-one-lock.ts";
import {
  processIdentity,
  unusedLocalPort,
} from "./local-system-one-process.ts";
import {
  LocalSystemOne,
  localSystemOneError,
  LocalSystemOneError,
} from "./local-system-one.ts";
import type { LocalSystemOneState } from "./local-system-one.ts";

const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ catch: localSystemOneError, try: run });

/** No CLI registration: index dispatches this private entry before Command.run. */
export const superviseLocalSystemOne = Effect.gen(function* supervise() {
  const local = yield* LocalSystemOne;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installed = yield* local.status;
  if (installed === undefined) {
    return yield* new LocalSystemOneError({
      message: "Local System One is not installed.",
    });
  }
  const directory = path.join(local.dataDirectory, installed.current.directory);
  const python = path.join(directory, "kev", ".venv", "bin", "python");
  yield* withLocalSystemOneLock(
    python,
    `${local.dataDirectory}.server-lock`,
    Effect.gen(function* runSupervisor() {
      const idle = yield* makeLocalSystemOneIdle;
      const clock = yield* Clock.Clock;
      const kevPort = yield* unusedLocalPort;
      const logSink = () =>
        fs
          .sink(path.join(local.dataDirectory, "server.log"), {
            flag: "a",
            mode: 0o600,
          })
          .pipe(Sink.as(new Uint8Array()));
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            python,
            [
              "-m",
              "kev.serve",
              "--run",
              `${installed.current.modelId}@${installed.current.nevRevision}`,
              "--host",
              "127.0.0.1",
              "--port",
              String(kevPort),
            ],
            {
              cwd: path.join(directory, "kev"),
              detached: true,
              env: localSystemOneEnvironment(directory),
              extendEnv: false,
              killSignal: "SIGKILL",
              stderr: logSink(),
              stdin: "ignore",
              stdout: logSink(),
            }
          )
        )
        .pipe(Effect.mapError(localSystemOneError));
      const exited = child.exitCode.pipe(
        Effect.as(true),
        Effect.mapError(localSystemOneError)
      );
      const proxy = http.createServer((request, response) => {
        // A private, read-only metrics endpoint does not count as a model request.
        if (
          request.url === "/__contingency/status" &&
          request.method === "GET"
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(Effect.runSync(idle.snapshot)));
          return;
        }
        Effect.runSync(idle.begin);
        let completed = false;
        const finish = () => {
          if (completed) {
            return;
          }
          completed = true;
          Effect.runSync(idle.end);
        };
        const upstream = http.request(
          {
            headers: { ...request.headers, host: `127.0.0.1:${kevPort}` },
            host: "127.0.0.1",
            method: request.method,
            path: request.url,
            port: kevPort,
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            response.once("finish", finish);
            answer.once("error", (error) => {
              response.destroy(error);
              finish();
            });
            answer.pipe(response);
          }
        );
        upstream.once("error", (error) => {
          if (response.headersSent) {
            response.destroy(error);
          } else {
            response.writeHead(503);
            response.end("Local System One is still starting.");
          }
          finish();
        });
        response.once("close", () => {
          upstream.destroy();
          finish();
        });
        request.once("error", () => {
          upstream.destroy();
          finish();
        });
        request.pipe(upstream);
      });
      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          proxy.close(() => resume(Effect.succeed(true)));
          proxy.closeAllConnections();
        })
      );
      yield* promise(async (signal) => {
        const listening = once(proxy, "listening", { signal });
        proxy.listen(0, "127.0.0.1");
        await listening;
      });
      const address = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ port: Schema.Int })
      )(proxy.address()).pipe(Effect.mapError(localSystemOneError));
      const server = {
        kevPid: child.pid,
        kevPort,
        kevStartIdentity: yield* processIdentity(child.pid),
        phase: "starting" as const,
        pid: process.pid,
        port: address.port,
        startIdentity: yield* processIdentity(process.pid),
        startedAt: new Date(yield* clock.currentTimeMillis).toISOString(),
      };
      const initial: LocalSystemOneState = {
        ...installed,
        crashes: Number(
          process.env.CONTINGENCY_LOCAL_SYSTEM_ONE_CRASHES ??
            installed.crashes ??
            0
        ),
        server,
      };
      yield* local.writeState(initial);
      const pidfile = path.join(local.dataDirectory, "server.pid.json");
      yield* fs
        .writeFileString(pidfile, JSON.stringify(server), { mode: 0o600 })
        .pipe(Effect.mapError(localSystemOneError));
      yield* Effect.addFinalizer(() =>
        fs.remove(pidfile, { force: true }).pipe(Effect.orDie)
      );
      // Parent holds the mutation lock until this acknowledgement. Readiness is separate.
      yield* Effect.callback<boolean, LocalSystemOneError>((resume) => {
        process.stdout.write("started\n", (error) =>
          resume(
            error
              ? Effect.fail(localSystemOneError(error))
              : Effect.succeed(true)
          )
        );
      });
      const changePhase = (phase: "ready" | "crashed") =>
        local.withLock(
          Effect.gen(function* persistPhase() {
            const state = yield* local.status;
            if (
              state?.server?.pid !== process.pid ||
              state.server.startIdentity !== server.startIdentity
            ) {
              return;
            }
            yield* local.writeState({
              ...state,
              crashes: (state.crashes ?? 0) + (phase === "crashed" ? 1 : 0),
              server: { ...state.server, phase },
            });
          })
        );
      const readiness = promise(async (signal) => {
        const response = await fetch(`http://127.0.0.1:${kevPort}/v1/models`, {
          signal,
        });
        if (!response.ok) {
          throw new Error(`Kev readiness returned ${response.status}.`);
        }
        await response.arrayBuffer();
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced("250 millis") }),
        Effect.andThen(changePhase("ready"))
      );
      yield* readiness.pipe(Effect.forkChild);
      const outcome = yield* Effect.raceFirst(
        idle.awaitIdle.pipe(Effect.as("idle" as const)),
        exited.pipe(Effect.as("crashed" as const))
      );
      yield* outcome === "crashed"
        ? changePhase("crashed")
        : local.withLock(
            Effect.gen(function* recordIdleShutdown() {
              const state = yield* local.status;
              if (state?.server?.pid === process.pid) {
                yield* local.writeState({ ...state, server: null });
              }
            })
          );
    }).pipe(Effect.scoped)
  );
});
