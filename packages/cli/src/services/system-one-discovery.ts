import { Clock, Config, Effect, Option } from "effect";
import type { ConfigProvider } from "effect";

import type { makeLocalSystemOneLifecycle } from "./local-system-one-lifecycle.ts";
import type { makeLocalSystemOne } from "./local-system-one.ts";
import { systemOneConfig, SystemOneError } from "./system-one.ts";
import type { SystemOneConfig } from "./system-one.ts";

/** Explicit machine endpoint, installed opt-in local model, or no catalog cost. */
export const resolveSystemOne = (
  provider: ConfigProvider.ConfigProvider,
  local: Pick<ReturnType<typeof makeLocalSystemOne>, "status">,
  lifecycle: Pick<
    ReturnType<typeof makeLocalSystemOneLifecycle>,
    "ensureStarted" | "awaitReady"
  >
) =>
  Effect.gen(function* discoverSystemOne() {
    const explicit = yield* systemOneConfig.parse(provider);
    if (Option.isSome(explicit)) {
      return explicit.value;
    }
    const enabled = yield* Config.Boolean("CONTINGENCY_SYSTEM_ONE_LOCAL")
      .pipe(Config.withDefault(true))
      .parse(provider);
    if (!enabled) {
      return;
    }
    const installed = yield* local.status;
    if (installed === undefined) {
      return;
    }
    const first = yield* Config.Boolean("CONTINGENCY_SYSTEM_ONE_FIRST")
      .pipe(Config.withDefault(false))
      .parse(provider);
    return {
      apiKey: Option.none(),
      first,
      local: (deadline) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.gen(function* readyLocalEndpoint() {
              const result = yield* lifecycle.ensureStarted;
              if ("reason" in result) {
                return yield* new SystemOneError({ message: result.reason });
              }
              const server = yield* lifecycle.awaitReady(deadline);
              const state = yield* local.status;
              if (state === undefined) {
                return yield* new SystemOneError({
                  message: "Local System One was removed.",
                });
              }
              return {
                model: `${state.current.modelId}@${state.current.nevRevision}`,
                url: `http://127.0.0.1:${server.port}/v1/systemone`,
              };
            }).pipe(
              Effect.timeout(Math.max(1, deadline - now)),
              Effect.mapError(
                (cause) =>
                  new SystemOneError({
                    message:
                      cause._tag === "TimeoutError"
                        ? "Local System One is still starting. Try again when it is ready."
                        : cause.message,
                  })
              )
            )
          )
        ),
      model: installed.current.modelId,
      url: "http://127.0.0.1/v1/systemone",
    } satisfies SystemOneConfig;
  });
