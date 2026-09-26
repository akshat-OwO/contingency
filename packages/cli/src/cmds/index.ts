import { Effect } from "effect";
import { CliError, Command } from "effect/unstable/cli";

import { mcpCommand } from "./mcp.ts";
import { webCommand } from "./web.ts";

const ROOT_COMMAND_NAME = "contingency";

// The root only groups subcommands, so a bare invocation shows help instead
// of exiting silently.
const rootCommand = Command.make(ROOT_COMMAND_NAME, {}, () =>
  Effect.fail(
    new CliError.ShowHelp({ commandPath: [ROOT_COMMAND_NAME], errors: [] })
  )
);

export const commands = rootCommand.pipe(
  Command.withSubcommands([mcpCommand, webCommand])
);
