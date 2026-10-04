import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { Data, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { ServerSpec } from "./agent-registration.ts";
import {
  CODEX_STARTUP_TIMEOUT_SECONDS,
  SERVER_NAME,
} from "./agent-registration.ts";
import type { RegisteredAgent } from "./catalog-directory.ts";
import { CATALOG_DIRECTORY } from "./flow-skill-catalog.ts";
import { STARTER_PROMPT_URI, starterPromptPath } from "./mcp-onboarding.ts";

/**
 * Launching an installed coding agent with Contingency connected for one
 * session (`contingency start`).
 *
 * The MCP server is supplied through each agent's own session-only options:
 * Claude Code's `--mcp-config` JSON and Codex's `-c` TOML overrides. Neither
 * writes the user's configuration, and neither touches authentication, model,
 * or permission settings. The agent spawns Contingency as a stdio child that
 * owns its own browser and Workspace on an available port.
 */

export interface AgentProfile {
  readonly binary: string;
  readonly id: RegisteredAgent;
  readonly install: string;
  readonly label: string;
  readonly signIn: string;
  /** The newest version this release was verified with. */
  readonly verifiedVersion: string;
}

export const AGENT_PROFILES: Readonly<Record<RegisteredAgent, AgentProfile>> = {
  claude: {
    binary: "claude",
    id: "claude",
    install:
      "Install Claude Code from https://code.claude.com/docs/en/setup, then run `claude` once to sign in.",
    label: "Claude Code",
    signIn: "Run `claude auth login`, or start `claude` and sign in.",
    verifiedVersion: "2.1.289",
  },
  codex: {
    binary: "codex",
    id: "codex",
    install:
      "Install Codex with `npm install -g @openai/codex` (see https://developers.openai.com/codex), then run `codex login`.",
    label: "Codex",
    signIn: "Run `codex login`.",
    verifiedVersion: "0.160.0",
  },
};

export class AgentLaunchError extends Data.TaggedError("AgentLaunchError")<{
  readonly message: string;
}> {}

export interface DetectedAgent {
  readonly executable: string;
  readonly profile: AgentProfile;
  readonly signedIn: boolean;
  readonly version: string | undefined;
}

/** Whether `candidate` is a file this process may execute. */
const isExecutable = (candidate: string) =>
  Effect.tryPromise(() => access(candidate, constants.X_OK)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  );

/** The first executable named `binary` on PATH. */
export const findOnPath = (binary: string, pathVariable: string | undefined) =>
  Effect.gen(function* findExecutable() {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const directory of (pathVariable ?? "").split(path.delimiter)) {
      if (directory.length === 0) {
        continue;
      }
      const candidate = path.join(directory, binary);
      const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (
        Option.isSome(info) &&
        info.value.type !== "Directory" &&
        (yield* isExecutable(candidate))
      ) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });

const output = (command: string, args: readonly string[]) =>
  Effect.gen(function* readOutput() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(
        ChildProcess.make(command, [...args], {
          extendEnv: true,
          stdin: "ignore",
        })
      )
      .pipe(Effect.timeout("20 seconds"), Effect.option);
  });

const exitCode = (command: string, args: readonly string[]) =>
  Effect.gen(function* readExitCode() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .exitCode(
        ChildProcess.make(command, [...args], {
          extendEnv: true,
          stderr: "ignore",
          stdin: "ignore",
          stdout: "ignore",
        })
      )
      .pipe(Effect.timeout("20 seconds"), Effect.option);
  });

const ClaudeAuthStatus = Schema.Struct({ loggedIn: Schema.Boolean });

const VERSION = /\d+\.\d+\.\d+/u;

/** Whether the installed agent reports a signed-in account. */
const signedIn = (agent: RegisteredAgent, executable: string) =>
  Effect.gen(function* checkSignIn() {
    if (agent === "claude") {
      const status = yield* output(executable, ["auth", "status"]);
      if (Option.isNone(status)) {
        return false;
      }
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(ClaudeAuthStatus)
      )(status.value.trim());
      return Option.isSome(decoded) && decoded.value.loggedIn;
    }
    const code = yield* exitCode(executable, ["login", "status"]);
    return Option.isSome(code) && code.value === 0;
  });

export const detectAgent = (
  agent: RegisteredAgent,
  pathVariable: string | undefined
) =>
  Effect.gen(function* detect() {
    const profile = AGENT_PROFILES[agent];
    const executable = yield* findOnPath(profile.binary, pathVariable);
    if (Option.isNone(executable)) {
      return Option.none<DetectedAgent>();
    }
    const versionOutput = yield* output(executable.value, ["--version"]);
    const version = Option.isSome(versionOutput)
      ? VERSION.exec(versionOutput.value)?.[0]
      : undefined;
    return Option.some({
      executable: executable.value,
      profile,
      signedIn: yield* signedIn(agent, executable.value),
      version,
    } satisfies DetectedAgent);
  });

const versionParts = (version: string): number[] =>
  version.split(".").map(Number);

/** Whether `version` is older than the verified one. */
export const olderThan = (version: string, verified: string): boolean => {
  const actual = versionParts(version);
  const reference = versionParts(verified);
  for (let index = 0; index < reference.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = reference[index] ?? 0;
    if (left !== right) {
      return left < right;
    }
  }
  return false;
};

/** How to start this same CLI again from an agent or a registration. */
export interface CliInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

/**
 * The current CLI as a reusable command. A run from the npx cache is
 * re-invoked through npx at the same version, because that cache directory is
 * not a stable place to point a permanent registration at.
 */
export const currentInvocation = (input: {
  readonly execPath: string;
  readonly packageName: string;
  readonly script: string;
  readonly version: string;
}): CliInvocation =>
  input.script.split(path.sep).includes("_npx")
    ? {
        args: ["-y", `${input.packageName}@${input.version}`],
        command: "npx",
      }
    : { args: [path.resolve(input.script)], command: input.execPath };

/** The session-only server: this directory's catalog and an available port. */
export const sessionServerSpec = (input: {
  readonly agent: RegisteredAgent;
  readonly directory: string;
  readonly invocation: CliInvocation;
}): ServerSpec => ({
  args: [
    ...input.invocation.args,
    "mcp",
    "--agent",
    input.agent,
    "--fallback-directory",
    input.directory,
  ],
  command: input.invocation.command,
  env: {
    CONTINGENCY_CATALOG_ROOT: path.join(input.directory, CATALOG_DIRECTORY),
    CONTINGENCY_MCP_PORT: "0",
  },
});

/** A POSIX shell word, so a launch-context command can be pasted as-is. */
export const shellQuote = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export interface LaunchContext {
  readonly agent: AgentProfile;
  readonly catalogRoot: string;
  readonly directory: string;
  readonly registrationCommand: string;
}

export const registrationCommand = (input: {
  readonly agent: RegisteredAgent;
  readonly directory: string;
  readonly invocation: CliInvocation;
}): string =>
  [
    input.invocation.command,
    ...input.invocation.args,
    "register",
    "--agent",
    input.agent,
    "--fallback-directory",
    input.directory,
  ]
    .map(shellQuote)
    .join(" ");

/**
 * The first message the agent receives. It is short on purpose: the
 * procedure is the bundled starter prompt, served by the same server version
 * as an MCP resource and present on disk beside the CLI.
 */
export const initialMessage = (context: LaunchContext): string =>
  [
    "Start Contingency onboarding.",
    "After starting or switching a session, send its returned viewUrl as a clickable Workspace link in a user-visible message before your next browser action. Share the new link for each Example, Teaching session, Dry Run, and Run.",
    `Read the MCP resource ${STARTER_PROMPT_URI} from the ${SERVER_NAME} server and follow it. The same prompt is in ${starterPromptPath}.`,
    "",
    "Launch context:",
    `- Agent: ${context.agent.label}`,
    `- Working directory: ${context.directory}`,
    `- Catalog Root: ${context.catalogRoot}`,
    `- Original onboarding directory (fallback for registration across projects): ${context.directory}`,
    `- Registration command (add --scope project or --scope user, and --replace only after the user chooses replacement): ${context.registrationCommand}`,
  ].join("\n");

/** Claude Code's `--mcp-config` document for one stdio server. */
export const claudeMcpConfig = (spec: ServerSpec): string =>
  JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        args: spec.args,
        command: spec.command,
        env: spec.env,
        type: "stdio",
      },
    },
  });

const tomlInlineTable = (record: Readonly<Record<string, string>>): string =>
  `{ ${Object.entries(record)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ")} }`;

/**
 * Codex `-c` overrides for one stdio server. Codex starts the browser server
 * within its default startup window only when Chromium is warm, so the window
 * is widened for this server alone.
 */
export const codexMcpOverrides = (spec: ServerSpec): string[] => {
  const key = `mcp_servers.${SERVER_NAME}`;
  return [
    `${key}.command=${JSON.stringify(spec.command)}`,
    `${key}.args=[${spec.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `${key}.env=${tomlInlineTable(spec.env)}`,
    `${key}.startup_timeout_sec=${CODEX_STARTUP_TIMEOUT_SECONDS}`,
  ].flatMap((override) => ["-c", override]);
};

/**
 * The agent's argument vector. `extra` holds arguments the user passed after
 * `--`, such as `exec` for a non-interactive Codex run; the initial message
 * stays last so both agents read it as their prompt.
 */
export const agentArguments = (input: {
  readonly agent: RegisteredAgent;
  readonly extra: readonly string[];
  readonly message: string;
  readonly spec: ServerSpec;
}): string[] =>
  input.agent === "claude"
    ? [
        ...input.extra,
        // `--mcp-config` takes several values, so `--` ends it before the prompt.
        "--mcp-config",
        claudeMcpConfig(input.spec),
        "--",
        input.message,
      ]
    : [...codexMcpOverrides(input.spec), ...input.extra, input.message];
