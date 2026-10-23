import { Clock, Context, Effect } from "effect";

import { LocalSystemOneError } from "./local-system-one.ts";
import type {
  LocalSystemOneState,
  makeLocalSystemOne,
} from "./local-system-one.ts";

type Task<A> = Effect.Effect<A, LocalSystemOneError>;
export type LocalSystemOneServer = NonNullable<LocalSystemOneState["server"]>;
export interface LocalSystemOneLifecycleIO {
  readonly local: ReturnType<typeof makeLocalSystemOne>;
  readonly alive: (server: LocalSystemOneServer) => Task<boolean>;
  readonly memoryPressure: Task<boolean>;
  readonly launch: (state: LocalSystemOneState) => Task<LocalSystemOneServer>;
  readonly stop: (server: LocalSystemOneServer) => Task<void>;
  readonly metrics: (
    server: LocalSystemOneServer
  ) => Task<{ rssBytes: number; idleMs: number }>;
}

export type LocalSystemOneStartResult =
  | { readonly started: boolean; readonly server: LocalSystemOneServer }
  | { readonly started: false; readonly reason: string };

export const makeLocalSystemOneLifecycle = (io: LocalSystemOneLifecycleIO) => {
  const startUnderLock = (explicit = false): Task<LocalSystemOneStartResult> =>
    io.local.withLock(
      Effect.gen(function* ensureStarted() {
        let state = yield* io.local.status;
        if (state === undefined) {
          return {
            reason: "Local System One is not installed.",
            started: false,
          };
        }
        if (
          state.server !== null &&
          state.server.phase !== "crashed" &&
          (yield* io.alive(state.server))
        ) {
          if (explicit) {
            yield* io.local.writeState({ ...state, crashes: 0 });
          }
          return { server: state.server, started: false };
        }
        if (state.server !== null && state.server.phase !== "crashed") {
          state = {
            ...state,
            crashes: (state.crashes ?? 0) + 1,
            server: { ...state.server, phase: "crashed" },
          };
          yield* io.local.writeState(state);
        }
        if (!explicit && (state.crashes ?? 0) >= 2) {
          return yield* new LocalSystemOneError({
            message: `Local System One crashed twice. See ${io.local.dataDirectory}/server.log. Run system-one start to enable it again.`,
          });
        }
        if (!explicit && (yield* io.memoryPressure)) {
          return {
            reason:
              "Local System One was not started because the machine is under memory pressure.",
            started: false,
          };
        }
        if (state.server !== null) {
          yield* io.stop(state.server);
        }
        const next = explicit ? { ...state, crashes: 0 } : state;
        // The launcher acknowledges the forwarder and pidfile, never model readiness.
        const server = yield* io.launch(next).pipe(
          Effect.tapError(() =>
            Effect.gen(function* recordLaunchFailure() {
              const latest = yield* io.local.status;
              const failed = latest?.server ?? null;
              yield* io.local.writeState({
                ...next,
                crashes: (next.crashes ?? 0) + 1,
                server:
                  failed === null ? null : { ...failed, phase: "crashed" },
              });
            })
          )
        );
        return { server, started: true };
      })
    );
  const start = (explicit = false): Task<LocalSystemOneStartResult> =>
    Effect.gen(function* installedBeforeLock() {
      if ((yield* io.local.status) === undefined) {
        return { reason: "Local System One is not installed.", started: false };
      }
      return yield* startUnderLock(explicit);
    });
  const stop = io.local.withLock(
    Effect.gen(function* stopLocalSystemOne() {
      const state = yield* io.local.status;
      if (state?.server === undefined || state.server === null) {
        return;
      }
      yield* io.stop(state.server);
      yield* io.local.writeState({ ...state, server: null });
    })
  );
  const awaitReady = (deadline: number) =>
    Effect.gen(function* awaitLocalSystemOne() {
      while (true) {
        const state = yield* io.local.status;
        if (state?.server?.phase === "crashed") {
          return yield* new LocalSystemOneError({
            message: `Local System One crashed; see ${io.local.dataDirectory}/server.log.`,
          });
        }
        if (
          state?.server?.phase === "ready" &&
          (yield* io.alive(state.server))
        ) {
          return state.server;
        }
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) {
          return yield* new LocalSystemOneError({
            message:
              "Local System One is still starting. Try again when it is ready.",
          });
        }
        yield* Effect.sleep(Math.min(100, remaining));
      }
    });
  const status = Effect.gen(function* serverStatus() {
    const state = yield* io.local.status;
    if (state?.server === undefined || state.server === null) {
      return { running: false, state };
    }
    const running = yield* io.alive(state.server);
    const metrics = running ? yield* io.metrics(state.server) : undefined;
    return { metrics, running, state };
  });
  return {
    awaitReady,
    ensureStarted: start(),
    start: start(true),
    status,
    stop,
  };
};

export const LocalSystemOneLifecycle = Context.Service<
  ReturnType<typeof makeLocalSystemOneLifecycle>
>("@contingency/LocalSystemOneLifecycle");
