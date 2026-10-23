import { Console, Effect, Layer } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { LocalSystemOneLifecycleLive } from "../services/local-system-one-lifecycle-live.ts";
import { LocalSystemOneLifecycle } from "../services/local-system-one-lifecycle.ts";
import { LocalSystemOneLive } from "../services/local-system-one-live.ts";
import {
  LOCAL_SYSTEM_ONE_MODELS,
  LOCAL_SYSTEM_ONE_RELEASE,
} from "../services/local-system-one-release.ts";
import {
  checkLocalSystemOneUpdates,
  readLocalSystemOneUpdateCache,
  writeLocalSystemOneUpdateCache,
  localSystemOneUpdateNotice,
} from "../services/local-system-one-updates.ts";
import {
  LocalSystemOne,
  LocalSystemOneError,
} from "../services/local-system-one.ts";

const status = Effect.gen(function* showLocalSystemOne() {
  const lifecycle = yield* LocalSystemOneLifecycle;
  const { state, running, metrics } = yield* lifecycle.status;
  yield* Console.log(
    state === undefined
      ? "Local System One is not installed."
      : `Model: ${state.current.model} (${state.current.modelId}@${state.current.nevRevision})\nKev: ${state.current.kevCommit}\nServer: ${running ? state.server?.phase : "not running"}${running ? `\nPort: ${state.server?.port}\nPID: ${state.server?.pid}\nKev PID: ${state.server?.kevPid}\nMemory: ${metrics?.rssBytes ?? 0} bytes RSS\nIdle: ${Math.floor((metrics?.idleMs ?? 0) / 1000)} seconds` : ""}`
  );
  if (state !== undefined) {
    const local = yield* LocalSystemOne;
    const notice = localSystemOneUpdateNotice(
      yield* readLocalSystemOneUpdateCache(local.dataDirectory, state)
    );
    if (notice !== undefined) {
      yield* Console.log(notice);
    }
  }
});

const setup = Command.make(
  "setup",
  {
    model: Flag.Literals("model", LOCAL_SYSTEM_ONE_MODELS).pipe(
      Flag.withDefault("nev")
    ),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  },
  ({ yes, model }) =>
    Effect.gen(function* setupFromTerminal() {
      const local = yield* LocalSystemOne;
      yield* local.setup(
        (platform) =>
          Effect.gen(function* confirmDownload() {
            const sizes = LOCAL_SYSTEM_ONE_RELEASE.sizes[platform];
            yield* Console.log(
              `Nev + Kev environment: ${(sizes.downloadBytes / 1e9).toFixed(1)} GB download; ${(sizes.diskBytes / 1e9).toFixed(1)} GB disk (${sizes.measured ? "measured" : "estimated; not yet measured on this platform"}).`
            );
            if (yes) {
              return true;
            }
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
              return yield* new LocalSystemOneError({
                message:
                  "Setup confirmation requires a terminal. Pass --yes to consent without a prompt.",
              });
            }
            return yield* Prompt.run(
              Prompt.Confirm({
                initial: false,
                message: "Download and install Local System One?",
              })
            ).pipe(
              Effect.mapError(
                (error) => new LocalSystemOneError({ message: error.message })
              )
            );
          }),
        model
      );
      yield* status;
    })
);

const remove = Command.make("remove", {}, () =>
  Effect.gen(function* removeFromTerminal() {
    const local = yield* LocalSystemOne;
    yield* local.remove;
    yield* Console.log("Removed Local System One.");
  })
);

const choose = (
  name: string,
  revisions: readonly string[],
  tested: string,
  current: string
) =>
  Effect.gen(function* chooseRevision() {
    yield* Console.log(
      `${name}: ${revisions.length === 0 ? "no newer upstream versions." : `${revisions.length} newer upstream versions.`}`
    );
    for (const revision of revisions) {
      yield* Console.log(
        `  ${revision} [${revision === tested ? "tested" : "untested"} by this release]`
      );
    }
    if (revisions.length === 0) {
      return current;
    }
    return yield* Prompt.run(
      Prompt.Select({
        choices: [
          {
            title: `Stay on ${current} [${current === tested ? "tested" : "untested"} by this release]`,
            value: current,
          },
          ...revisions.map((revision) => ({
            title: `${revision} [${revision === tested ? "tested" : "untested"} by this release]`,
            value: revision,
          })),
        ],
        message: `${name} version`,
      })
    ).pipe(
      Effect.mapError(
        (error) => new LocalSystemOneError({ message: error.message })
      )
    );
  });

const update = Command.make(
  "update",
  {
    rollback: Flag.Boolean("rollback").pipe(Flag.withDefault(false)),
  },
  ({ rollback }) =>
    Effect.gen(function* updateFromTerminal() {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return yield* new LocalSystemOneError({
          message: "Local System One update requires an interactive terminal.",
        });
      }
      const local = yield* LocalSystemOne;
      if (rollback) {
        yield* local.rollback;
        yield* status;
        return;
      }
      const installed = yield* local.status;
      if (installed === undefined) {
        return yield* new LocalSystemOneError({
          message: "Run contingency system-one setup first.",
        });
      }
      const versions = yield* checkLocalSystemOneUpdates(installed);
      yield* writeLocalSystemOneUpdateCache(local.dataDirectory, versions);
      const kevCommit = yield* choose(
        "Kev",
        versions.kev,
        LOCAL_SYSTEM_ONE_RELEASE.kevCommit,
        installed.current.kevCommit
      );
      const nevRevision = yield* choose(
        "Nev",
        versions.nev,
        LOCAL_SYSTEM_ONE_RELEASE.models.nev.revision,
        installed.current.nevRevision
      );
      if (
        kevCommit === installed.current.kevCommit &&
        nevRevision === installed.current.nevRevision
      ) {
        yield* Console.log("Kept the current Local System One.");
        return;
      }
      yield* local.setup(() => Effect.succeed(true), installed.current.model, {
        kevCommit,
        kevSha256:
          kevCommit === LOCAL_SYSTEM_ONE_RELEASE.kevCommit
            ? LOCAL_SYSTEM_ONE_RELEASE.kevSha256
            : undefined,
        nevRevision,
      });
      yield* status;
    })
);

export const systemOneCommand = Command.make(
  "system-one",
  {},
  () => status
).pipe(
  Command.withDescription(
    "Set up, update, run, inspect, or remove the opt-in Local System One."
  ),
  Command.withSubcommands([
    setup,
    update,
    Command.make("status", {}, () => status),
    remove,
    Command.make("start", {}, () =>
      Effect.gen(function* startFromTerminal() {
        const lifecycle = yield* LocalSystemOneLifecycle;
        const result = yield* lifecycle.start;
        yield* Console.log(
          "reason" in result
            ? result.reason
            : `Local System One ${result.started ? "starting" : result.server.phase} on http://127.0.0.1:${result.server.port} (PID ${result.server.pid}).`
        );
      })
    ),
    Command.make("stop", {}, () =>
      Effect.gen(function* stopFromTerminal() {
        const lifecycle = yield* LocalSystemOneLifecycle;
        yield* lifecycle.stop;
        yield* Console.log("Stopped Local System One.");
      })
    ),
  ]),
  Command.provide(
    Layer.merge(
      LocalSystemOneLive,
      LocalSystemOneLifecycleLive.pipe(Layer.provide(LocalSystemOneLive))
    )
  )
);
