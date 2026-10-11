import path from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { versionReadiness } from "./agent-harness.ts";
import type { AgentHarness, LaunchRequest } from "./agent-harness.ts";
import {
  SERVER_NAME,
  RegistrationError,
  ServerEntry,
  baseRegistrationServerSpec,
  commandOutcome,
  describeDifferences,
  describeEntry,
  readJsonConfig,
} from "./agent-registration.ts";
import type {
  ExistingEntry,
  RegistrationOutcome,
  RegistrationRequest,
  RegistrationScope,
  ServerEntryValue,
  ServerSpec,
} from "./agent-registration.ts";

/**
 * Claude Code as an Agent Harness.
 *
 * A session receives the MCP server through `--mcp-config` JSON, which writes
 * no configuration and leaves authentication, model, and permission settings
 * alone. Permanent registration goes through Claude's own `claude mcp`
 * commands. Claude documents `CLAUDE_PROJECT_DIR` for the stdio servers it
 * spawns, which names the current project.
 */

const ServersWithContingency = Schema.Struct({
  [SERVER_NAME]: Schema.optional(ServerEntry),
});

const ClaudeConfig = Schema.Struct({
  mcpServers: Schema.optional(ServersWithContingency),
  projects: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ mcpServers: Schema.optional(ServersWithContingency) })
    )
  ),
});
type ClaudeConfigValue = typeof ClaudeConfig.Type;

const SharedMcpJson = Schema.Struct({
  mcpServers: Schema.optional(ServersWithContingency),
});

/** Claude Code's configuration file: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
export const claudeConfigPath = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string => {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(
    configured === undefined || configured.length === 0 ? home : configured,
    ".claude.json"
  );
};

const claudeSpec = (
  entry: ServerEntryValue,
  location: string
): ExistingEntry => {
  const type = entry.type ?? "stdio";
  return {
    extras: type === "stdio" ? [] : [`type is ${type}, not stdio`],
    location,
    spec: {
      args: entry.args ?? [],
      command: entry.command ?? "",
      env: entry.env ?? {},
    },
  };
};

export interface ClaudeEntries {
  /** `.mcp.json` in the project: shared, checked-in configuration. */
  readonly shared: ExistingEntry | undefined;
  /** Claude's `local` scope: private to this project. */
  readonly project: ExistingEntry | undefined;
  readonly user: ExistingEntry | undefined;
}

const optionalEntry = (
  entry: ServerEntryValue | undefined,
  location: string
): ExistingEntry | undefined =>
  entry === undefined ? entry : claudeSpec(entry, location);

export const readClaudeEntries = (input: {
  readonly configPath: string;
  readonly projectDirectory: string;
}) =>
  Effect.gen(function* readClaude() {
    const config: ClaudeConfigValue = Option.getOrElse(
      yield* readJsonConfig(input.configPath, ClaudeConfig),
      () => ({})
    );
    const sharedPath = path.join(input.projectDirectory, ".mcp.json");
    const shared = yield* readJsonConfig(sharedPath, SharedMcpJson);
    return {
      project: optionalEntry(
        config.projects?.[input.projectDirectory]?.mcpServers?.[SERVER_NAME],
        `Claude Code local scope for ${input.projectDirectory}`
      ),
      shared: optionalEntry(
        Option.getOrUndefined(shared)?.mcpServers?.[SERVER_NAME],
        sharedPath
      ),
      user: optionalEntry(
        config.mcpServers?.[SERVER_NAME],
        "Claude Code user scope"
      ),
    } satisfies ClaudeEntries;
  });

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

/**
 * `extra` holds arguments the user passed after `--`. `--mcp-config` takes
 * several values, so `--` ends it before the prompt.
 */
const claudeArguments = (request: LaunchRequest): string[] => [
  ...request.extra,
  "--mcp-config",
  claudeMcpConfig(request.spec),
  "--",
  request.message,
];

const precedenceNotes = (
  scope: RegistrationScope,
  entries: ClaudeEntries,
  spec: ServerSpec
): string[] => {
  const notes: string[] = [];
  if (scope === "user") {
    for (const higher of [entries.project, entries.shared]) {
      if (
        higher !== undefined &&
        describeDifferences(higher.spec, spec, higher.extras).length > 0
      ) {
        notes.push(
          `In this project, ${describeEntry(higher)} and takes precedence over the user registration. Other projects use the user registration.`
        );
      }
    }
  } else if (
    entries.user !== undefined &&
    describeDifferences(entries.user.spec, spec, entries.user.extras).length > 0
  ) {
    notes.push(
      `${describeEntry(entries.user)}. This project uses its own registration instead; other projects keep the user registration.`
    );
  }
  return notes;
};

const registerClaude = (request: RegistrationRequest) =>
  Effect.gen(function* registerWithClaude() {
    const configPath = claudeConfigPath(request.env, request.home);
    const entries = yield* readClaudeEntries({
      configPath,
      projectDirectory: request.projectDirectory,
    });
    const existing = request.scope === "user" ? entries.user : entries.project;
    const claudeScope = request.scope === "user" ? "user" : "local";
    const location =
      request.scope === "user"
        ? "Claude Code user scope"
        : `Claude Code local scope for ${request.projectDirectory}`;
    const notes = precedenceNotes(request.scope, entries, request.spec);
    const commandOptions = { cwd: request.projectDirectory, env: request.env };
    if (existing !== undefined) {
      const differences = describeDifferences(
        existing.spec,
        request.spec,
        existing.extras
      );
      if (differences.length === 0) {
        return { _tag: "kept", location, notes } satisfies RegistrationOutcome;
      }
      if (!request.replace) {
        return {
          _tag: "differs",
          differences,
          location,
          notes,
        } satisfies RegistrationOutcome;
      }
      yield* commandOutcome(
        "claude",
        ["mcp", "remove", "--scope", claudeScope, SERVER_NAME],
        commandOptions
      );
    }
    yield* commandOutcome(
      "claude",
      [
        "mcp",
        "add-json",
        "--scope",
        claudeScope,
        SERVER_NAME,
        JSON.stringify({
          args: request.spec.args,
          command: request.spec.command,
          env: request.spec.env,
          type: "stdio",
        }),
      ],
      commandOptions
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RegistrationError({
            message:
              existing === undefined
                ? cause.message
                : `${cause.message} The previous ${location} registration was removed. Retry registration to reconnect Contingency.`,
          })
      )
    );
    const written = yield* readClaudeEntries({
      configPath,
      projectDirectory: request.projectDirectory,
    });
    const check = request.scope === "user" ? written.user : written.project;
    if (
      check === undefined ||
      describeDifferences(check.spec, request.spec, check.extras).length > 0
    ) {
      return yield* Effect.fail(
        new RegistrationError({
          message: `Claude Code reported success, but ${location} does not hold the expected entry.`,
        })
      );
    }
    return {
      _tag: existing === undefined ? "registered" : "replaced",
      location,
      notes,
    } satisfies RegistrationOutcome;
  });

/** The server a permanent Claude Code registration starts. */
export const claudeRegistrationServerSpec = (
  input: Parameters<AgentHarness["registrationServerSpec"]>[0]
): ServerSpec => ({
  ...baseRegistrationServerSpec({ ...input, harness: "claude" }),
});

export class ClaudeHarness extends Context.Service<
  ClaudeHarness,
  AgentHarness
>()("@contingency/AgentHarness/claude") {}

export const ClaudeHarnessLive = Layer.effect(
  ClaudeHarness,
  Effect.gen(function* makeClaudeHarness() {
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    >();
    return {
      currentProjectDirectory: ({ cwd, env }) => {
        const reported = env.CLAUDE_PROJECT_DIR?.trim();
        return Effect.succeed(
          reported === undefined || reported.length === 0 ? cwd : reported
        );
      },
      id: "claude",
      install:
        "Install Claude Code from https://code.claude.com/docs/en/setup.",
      label: "Claude Code",
      launchPlan: (request) =>
        Effect.succeed({
          args: claudeArguments(request),
          command: request.executable,
          env: {},
        }),
      readiness: (pathVariable) =>
        versionReadiness({
          binary: "claude",
          major: 2,
          pathVariable,
          product: /\(Claude Code\)/u,
        }).pipe(Effect.provideContext(context)),
      register: (request) =>
        registerClaude(request).pipe(Effect.provideContext(context)),
      registrationServerSpec: claudeRegistrationServerSpec,
      verifiedVersion: "2.1.289",
    } satisfies AgentHarness;
  })
);
