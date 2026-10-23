import { Console, Effect } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { LocalSystemOneLive } from "../services/local-system-one-live.ts";
import {
  LOCAL_SYSTEM_ONE_MODELS,
  LOCAL_SYSTEM_ONE_RELEASE,
} from "../services/local-system-one-release.ts";
import {
  LocalSystemOne,
  LocalSystemOneError,
} from "../services/local-system-one.ts";

const status = Effect.gen(function* showLocalSystemOne() {
  const local = yield* LocalSystemOne;
  const state = yield* local.status;
  yield* Console.log(
    state === undefined
      ? "Local System One is not installed."
      : `Model: ${state.current.model} (${state.current.modelId}@${state.current.nevRevision})\nKev: ${state.current.kevCommit}\nServer: not running`
  );
});

const setup = Command.make(
  "setup",
  {
    model: Flag.Literals("model", LOCAL_SYSTEM_ONE_MODELS).pipe(
      Flag.withDefault("nev")
    ),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  },
  ({ yes }) =>
    Effect.gen(function* setupFromTerminal() {
      const local = yield* LocalSystemOne;
      yield* local.setup((platform) =>
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
        })
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

export const systemOneCommand = Command.make(
  "system-one",
  {},
  () => status
).pipe(
  Command.withDescription(
    "Set up, inspect, or remove the opt-in Local System One."
  ),
  Command.withSubcommands([
    setup,
    Command.make("status", {}, () => status),
    remove,
  ]),
  Command.provide(LocalSystemOneLive)
);
