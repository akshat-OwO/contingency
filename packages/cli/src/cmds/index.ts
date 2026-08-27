import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { runCommand } from "./run.ts";
import { webCommand } from "./web.ts";

const rootCommand = Command.make("contingency", {}, () => Effect.void);

export const commands = rootCommand.pipe(
  Command.withSubcommands([runCommand, webCommand])
);
