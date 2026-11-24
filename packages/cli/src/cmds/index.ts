import { Effect, Option } from "effect";
import { CliError, Command } from "effect/cli";

import {
  applyLaunchFlags,
  applySettingsLogLevel,
  DebugFlag,
  LogLevelFlag,
} from "../services/observability.ts";
import { loadSettings, userSettingsDirectory } from "../services/settings.ts";
import { configCommand } from "./config.ts";
import { docsCommand } from "./docs.ts";
import { mcpCommand } from "./mcp.ts";
import { registerCommand } from "./register.ts";
import { startCommand } from "./start.ts";
import { systemOneCommand } from "./system-one.ts";
import { webCommand } from "./web.ts";

const ROOT_COMMAND_NAME = "contingency";

// The root only groups subcommands, so a bare invocation shows help instead
// of exiting silently.
const rootCommand = Command.make(ROOT_COMMAND_NAME, {}, () =>
  Effect.fail(
    new CliError.ShowHelp({ commandPath: [ROOT_COMMAND_NAME], errors: [] })
  )
);

/**
 * Applies `--debug`, `--log-level`, and the user's own `log.level` before any
 * subcommand runs. A command that reads a project file applies it after.
 */
const applyLaunchLogLevel = Effect.gen(function* applyLaunchLogLevelEffect() {
  yield* applyLaunchFlags;
  // An invalid user file is reported by the command that reads it.
  const user = yield* loadSettings({
    catalogRoot: userSettingsDirectory(),
    env: process.env,
  }).pipe(Effect.option);
  if (Option.isSome(user)) {
    yield* applySettingsLogLevel(user.value.provider);
  }
});

export const commands = rootCommand.pipe(
  Command.withSubcommands([
    startCommand,
    mcpCommand,
    registerCommand,
    webCommand,
    docsCommand,
    configCommand,
    systemOneCommand,
  ]),
  Command.provideEffectDiscard(applyLaunchLogLevel),
  Command.withGlobalFlags([DebugFlag, LogLevelFlag])
);
