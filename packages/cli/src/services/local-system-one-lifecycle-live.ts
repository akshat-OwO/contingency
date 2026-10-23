import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, rm } from "node:fs/promises";
import path from "node:path";

import { Clock, Effect, Layer, Schema } from "effect";

import {
  LocalSystemOneLifecycle,
  makeLocalSystemOneLifecycle,
} from "./local-system-one-lifecycle.ts";
import {
  localSystemOneMemoryPressure,
  localSystemOneOutput,
  processAlive,
  stopLocalSystemOneProcesses,
  supervisorAlive,
} from "./local-system-one-process.ts";
import {
  LocalSystemOne,
  localSystemOneError,
  LocalSystemOneError,
} from "./local-system-one.ts";

export const LocalSystemOneLifecycleLive = Layer.effect(
  LocalSystemOneLifecycle,
  Effect.gen(function* lifecycleLive() {
    const local = yield* LocalSystemOne;
    return makeLocalSystemOneLifecycle({
      alive: (server) =>
        supervisorAlive(server).pipe(
          Effect.flatMap((alive) =>
            alive
              ? processAlive(server.kevPid, server.kevStartIdentity)
              : Effect.succeed(false)
          )
        ),
      launch: (state) =>
        Effect.gen(function* detachSupervisor() {
          const log = yield* Effect.acquireRelease(
            Effect.tryPromise({
              catch: localSystemOneError,
              try: () =>
                open(path.join(local.dataDirectory, "server.log"), "a", 0o600),
            }),
            (file) => Effect.promise(() => file.close())
          );
          let acknowledged = false;
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn(
                process.execPath,
                [
                  ...process.execArgv,
                  path.resolve(process.argv[1] ?? ""),
                  "system-one",
                  "__supervise",
                ],
                {
                  detached: true,
                  env: {
                    ...process.env,
                    CONTINGENCY_LOCAL_SYSTEM_ONE_CRASHES: String(
                      state.crashes ?? 0
                    ),
                  },
                  stdio: ["ignore", "pipe", log.fd],
                }
              )
            ),
            (process) =>
              Effect.promise(async () => {
                if (
                  acknowledged ||
                  process.exitCode !== null ||
                  process.signalCode !== null
                ) {
                  return;
                }
                const closed = once(process, "close");
                process.kill("SIGTERM");
                await closed;
              })
          );
          if (child.stdout === null) {
            return yield* new LocalSystemOneError({
              message: "Supervisor acknowledgement pipe is missing.",
            });
          }
          const acknowledgement = child.stdout;
          yield* Effect.raceFirst(
            Effect.tryPromise({
              catch: localSystemOneError,
              try: (signal) => once(acknowledgement, "data", { signal }),
            }),
            Effect.tryPromise({
              catch: localSystemOneError,
              try: (signal) => once(child, "exit", { signal }),
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new LocalSystemOneError({
                    message: `Supervisor exited before acknowledgement; see ${local.dataDirectory}/server.log.`,
                  })
                )
              )
            )
          ).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(localSystemOneError)
          );
          acknowledged = true;
          child.stdout.destroy();
          child.unref();
          const current = yield* local.status;
          if (current?.server === undefined || current.server === null) {
            return yield* new LocalSystemOneError({
              message: "Supervisor did not record its identity.",
            });
          }
          return current.server;
        }).pipe(Effect.scoped),
      local,
      memoryPressure: localSystemOneMemoryPressure,
      metrics: (server) =>
        Effect.gen(function* metrics() {
          const rss = yield* localSystemOneOutput("ps", [
            "-p",
            String(server.kevPid),
            "-o",
            "rss=",
          ]).pipe(Effect.orElseSucceed(() => "0"));
          const activity = yield* Effect.tryPromise({
            catch: localSystemOneError,
            try: async (signal) => {
              const response = await fetch(
                `http://127.0.0.1:${server.port}/__contingency/status`,
                { signal }
              );
              const body: unknown = await response.json();
              return Schema.decodeUnknownSync(
                Schema.Struct({ lastActivity: Schema.Number })
              )(body);
            },
          }).pipe(
            Effect.timeout("1 second"),
            Effect.orElseSucceed(() => ({ lastActivity: Date.now() }))
          );
          return {
            idleMs: Math.max(
              0,
              (yield* Clock.currentTimeMillis) - activity.lastActivity
            ),
            rssBytes: Number(rss) * 1024,
          };
        }),
      stop: (server) =>
        stopLocalSystemOneProcesses(server).pipe(
          Effect.andThen(
            Effect.tryPromise({
              catch: localSystemOneError,
              try: () =>
                rm(path.join(local.dataDirectory, "server.pid.json"), {
                  force: true,
                }),
            })
          )
        ),
    });
  })
);
