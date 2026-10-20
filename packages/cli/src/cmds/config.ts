import { Console, Effect } from "effect";
import { CliError, Command } from "effect/cli";

import { defaultCatalogRoot } from "../services/flow-skill-catalog.ts";
import { initSettingsFile } from "../services/settings.ts";

const initCommand = Command.make("init", {}, () =>
  Effect.gen(function* runConfigInit() {
    const file = yield* initSettingsFile(defaultCatalogRoot());
    yield* Console.log(`Created ${file}.`);
  })
).pipe(
  Command.withDescription(
    "Create config.json in the Catalog Root with a $schema pinned to this CLI version. Refuses to overwrite an existing file."
  )
);

export const configCommand = Command.make("config", {}, () =>
  Effect.fail(
    new CliError.ShowHelp({
      commandPath: ["contingency", "config"],
      errors: [],
    })
  )
).pipe(
  Command.withDescription("Manage Contingency Settings files."),
  Command.withSubcommands([initCommand])
);
