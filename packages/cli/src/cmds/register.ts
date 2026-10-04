import { realpathSync } from "node:fs";
import path from "node:path";

import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { currentInvocation } from "../services/agent-launch.ts";
import {
  register,
  registrationServerSpec,
} from "../services/agent-registration.ts";
import type { RegistrationOutcome } from "../services/agent-registration.ts";
import {
  REGISTERED_AGENTS,
  defaultHomeDirectory,
} from "../services/catalog-directory.ts";

/** Claude keys project scopes by real path, so `/tmp` and `/private/tmp` agree. */
const realDirectory = (directory: string): string => {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
};

const report = (outcome: RegistrationOutcome): string[] => {
  const lines: string[] = [];
  switch (outcome._tag) {
    case "kept": {
      lines.push(
        `Kept: ${outcome.location} already has an equivalent Contingency registration. Nothing changed.`
      );
      break;
    }
    case "registered": {
      lines.push(`Registered Contingency in ${outcome.location}.`);
      break;
    }
    case "replaced": {
      lines.push(
        `Replaced the Contingency registration in ${outcome.location}.`
      );
      break;
    }
    case "differs": {
      lines.push(
        `Differs: ${outcome.location} already has a different Contingency registration. Nothing changed.`,
        ...outcome.differences.map((difference) => `- ${difference}`),
        "Ask the user whether to keep it or replace it. To replace it, run this command again with --replace."
      );
      break;
    }
    default: {
      break;
    }
  }
  return [...lines, ...outcome.notes.map((note) => `Note: ${note}`)];
};

/**
 * Permanent MCP registration, run by the agent after the user chooses a
 * scope. It checks before it writes: an equivalent entry is kept, and a
 * different one is replaced only with `--replace`.
 */
export const registerCommand = Command.make(
  "register",
  {
    agent: Flag.Literals("agent", REGISTERED_AGENTS).pipe(
      Flag.withDescription("The agent whose configuration to update.")
    ),
    fallbackDirectory: Flag.String("fallback-directory").pipe(
      Flag.withDescription(
        "The original onboarding directory. Sessions use it only when no usable current project directory is available."
      ),
      Flag.optional
    ),
    projectDirectory: Flag.String("project-directory").pipe(
      Flag.withDescription(
        "The project for --scope project. Defaults to the current directory."
      ),
      Flag.optional
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription(
        "Replace a different existing registration. Use only after the user chooses replacement."
      ),
      Flag.withDefault(false)
    ),
    scope: Flag.Literals("scope", ["project", "user"]).pipe(
      Flag.withDescription(
        "project: this project only. user: every project, each with its own .contingency catalog."
      )
    ),
  },
  Effect.fnUntraced(function* runRegister(options) {
    const projectDirectory = realDirectory(
      Option.getOrElse(options.projectDirectory, () => process.cwd())
    );
    const fallbackDirectory = path.resolve(
      Option.getOrElse(options.fallbackDirectory, () => projectDirectory)
    );
    const spec = registrationServerSpec({
      agent: options.agent,
      fallbackDirectory,
      invocation: currentInvocation({
        execPath: process.execPath,
        packageName: packageJson.name,
        script: process.argv[1] ?? "",
        version: packageJson.version,
      }),
    });
    const outcome = yield* register({
      agent: options.agent,
      env: process.env,
      home: defaultHomeDirectory(),
      projectDirectory,
      replace: options.replace,
      scope: options.scope,
      spec,
    });
    yield* Console.log(report(outcome).join("\n"));
    if (outcome._tag === "differs") {
      yield* Effect.sync(() => {
        process.exitCode = 2;
      });
    }
  })
).pipe(
  Command.withDescription(
    "Register Contingency's MCP server permanently for Claude Code or Codex, for this project or for every project."
  )
);
