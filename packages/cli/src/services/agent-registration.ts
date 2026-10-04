import path from "node:path";

import { Data, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { RegisteredAgent } from "./catalog-directory.ts";
import { findTomlTable, replaceTomlTable, tomlString } from "./toml-table.ts";

/**
 * Permanent MCP registration after onboarding (ADR 0049).
 *
 * Every write goes through a check first: an equivalent existing entry is
 * kept, a different one is reported and replaced only on an explicit request,
 * and unrelated configuration is never rewritten. Claude Code is changed with
 * its own `claude mcp` commands. Codex user configuration is changed with
 * `codex mcp add`, and Codex project configuration, which that command cannot
 * write, is edited as text around one table.
 */

export const SERVER_NAME = "contingency";

export type RegistrationScope = "project" | "user";

/** The stdio server a registration launches. */
export interface ServerSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

export class RegistrationError extends Data.TaggedError("RegistrationError")<{
  readonly message: string;
}> {}

/**
 * The server a permanent registration starts. It always binds an available
 * Workspace port and names its agent, so the process finds the current
 * project the way that agent reports it, and it carries the original
 * onboarding directory only as the fallback.
 */
export const registrationServerSpec = (input: {
  readonly agent: RegisteredAgent;
  readonly fallbackDirectory: string;
  readonly invocation: {
    readonly args: readonly string[];
    readonly command: string;
  };
}): ServerSpec => ({
  args: [
    ...input.invocation.args,
    "mcp",
    "--agent",
    input.agent,
    "--fallback-directory",
    input.fallbackDirectory,
  ],
  command: input.invocation.command,
  env: { CONTINGENCY_MCP_PORT: "0" },
});

/** What differs between an existing entry and the wanted one, in words. */
export const describeDifferences = (
  existing: ServerSpec,
  wanted: ServerSpec,
  extras: readonly string[] = []
): string[] => {
  const differences: string[] = [];
  if (existing.command !== wanted.command) {
    differences.push(
      `command is ${JSON.stringify(existing.command)}; Contingency would use ${JSON.stringify(wanted.command)}`
    );
  }
  if (JSON.stringify(existing.args) !== JSON.stringify(wanted.args)) {
    differences.push(
      `args are ${JSON.stringify(existing.args)}; Contingency would use ${JSON.stringify(wanted.args)}`
    );
  }
  const keys = new Set([
    ...Object.keys(existing.env),
    ...Object.keys(wanted.env),
  ]);
  for (const key of [...keys].toSorted()) {
    if (existing.env[key] !== wanted.env[key]) {
      differences.push(
        `env ${key} is ${existing.env[key] === undefined ? "unset" : JSON.stringify(existing.env[key])}; Contingency would use ${wanted.env[key] === undefined ? "unset" : JSON.stringify(wanted.env[key])}`
      );
    }
  }
  return [...differences, ...extras];
};

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * A Contingency server entry, reduced to what registration compares. Struct
 * decoding ignores every other key, so unrelated servers and settings are
 * never parsed, and never rewritten.
 */
const ServerEntry = Schema.Struct({
  args: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  type: Schema.optional(Schema.String),
});
type ServerEntryValue = typeof ServerEntry.Type;

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

interface ExistingEntry {
  /** Settings outside command, args, and env that change behavior. */
  readonly extras: readonly string[];
  readonly spec: ServerSpec;
  /** Where the entry lives, for messages. */
  readonly location: string;
}

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

const readError = (filePath: string) => (cause: { readonly message: string }) =>
  new RegistrationError({
    message: `Could not read ${filePath}: ${cause.message}`,
  });

/** A file's text, or none when it does not exist. */
const readOptionalText = (filePath: string) =>
  Effect.gen(function* readOptionalFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem
      .exists(filePath)
      .pipe(Effect.mapError(readError(filePath)));
    if (!exists) {
      return Option.none<string>();
    }
    return Option.some(
      yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.mapError(readError(filePath)))
    );
  });

/** Decode a JSON configuration file, refusing a file Contingency cannot read safely. */
const readJsonConfig = <S extends Schema.Constraint>(
  filePath: string,
  schema: S
) =>
  Effect.gen(function* readJsonConfigFile() {
    const text = yield* readOptionalText(filePath);
    if (Option.isNone(text)) {
      return Option.none<S["Type"]>();
    }
    return Option.some(
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        text.value
      ).pipe(
        Effect.mapError(
          () =>
            new RegistrationError({
              message: `${filePath} is not JSON Contingency can read, so Contingency will not change it.`,
            })
        )
      )
    );
  });

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

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Codex's user configuration: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. */
export const codexUserConfigPath = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string => {
  const configured = env.CODEX_HOME?.trim();
  return path.join(
    configured === undefined || configured.length === 0
      ? path.join(home, ".codex")
      : configured,
    "config.toml"
  );
};

export const codexProjectConfigPath = (projectDirectory: string): string =>
  path.join(projectDirectory, ".codex", "config.toml");

const TABLE_PATH = ["mcp_servers", SERVER_NAME] as const;

/** Keys whose presence changes how Codex runs the server. */
const CODEX_BEHAVIOR_KEYS = new Set([
  "cwd",
  "enabled",
  "url",
  "enabled_tools",
  "disabled_tools",
  "env_vars",
]);

const unreadableEntry = "the entry is not a stdio command Contingency can read";

/**
 * The `[mcp_servers.contingency]` table in one Codex file, or none. A table
 * written in a form this module does not edit is a refusal, never a guess.
 */
export const codexEntryFromToml = (text: string, location: string) =>
  Effect.gen(function* readCodexTable() {
    const lookup = findTomlTable(text, TABLE_PATH);
    if (lookup._tag === "absent") {
      return Option.none<ExistingEntry>();
    }
    if (lookup._tag === "unsupported") {
      return yield* Effect.fail(
        new RegistrationError({
          message: `${location} defines ${SERVER_NAME} in a form Contingency does not edit (${lookup.reason}). Change it by hand or remove it, then retry.`,
        })
      );
    }
    const { values } = lookup.table;
    const extras = Object.keys(values).flatMap((key) =>
      CODEX_BEHAVIOR_KEYS.has(key) &&
      !(key === "enabled" && values[key] === true)
        ? [`${key} is set to ${JSON.stringify(values[key])}`]
        : []
    );
    const decoded = Schema.decodeUnknownOption(ServerEntry)(values);
    if (Option.isNone(decoded) || decoded.value.command === undefined) {
      return Option.some({
        extras: [...extras, unreadableEntry],
        location,
        spec: { args: [], command: "", env: {} },
      } satisfies ExistingEntry);
    }
    const entry = decoded.value;
    return Option.some({
      extras,
      location,
      spec: {
        args: entry.args ?? [],
        command: entry.command ?? "",
        env: entry.env ?? {},
      },
    } satisfies ExistingEntry);
  });

export const codexTable = (spec: ServerSpec): string => {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
  ];
  const env = Object.entries(spec.env);
  if (env.length > 0) {
    lines.push("", `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [key, value] of env) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n");
};

const readCodexEntry = (filePath: string) =>
  Effect.gen(function* readCodex() {
    const text = yield* readOptionalText(filePath);
    if (Option.isNone(text)) {
      return Option.none<ExistingEntry>();
    }
    return yield* codexEntryFromToml(text.value, filePath);
  });

/** Whether Codex trusts the project, which it requires before reading `.codex/config.toml`. */
export const codexTrustsProject = (
  userConfig: Option.Option<string>,
  projectDirectory: string
): boolean => {
  if (Option.isNone(userConfig)) {
    return false;
  }
  const lookup = findTomlTable(userConfig.value, [
    "projects",
    projectDirectory,
  ]);
  return (
    lookup._tag === "found" && lookup.table.values.trust_level === "trusted"
  );
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegistrationRequest {
  readonly agent: RegisteredAgent;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** A real path: Claude keys project scopes by it. */
  readonly projectDirectory: string;
  readonly replace: boolean;
  readonly scope: RegistrationScope;
  readonly spec: ServerSpec;
}

export type RegistrationOutcome =
  | {
      readonly _tag: "differs";
      readonly differences: readonly string[];
      readonly location: string;
      readonly notes: readonly string[];
    }
  | {
      readonly _tag: "kept" | "registered" | "replaced";
      readonly location: string;
      readonly notes: readonly string[];
    };

const commandOutcome = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }
) =>
  Effect.gen(function* runAndCheck() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: { ...options.env },
          extendEnv: false,
          stderr: "inherit",
          stdin: "ignore",
          stdout: "ignore",
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RegistrationError({
              message: `${command} ${args.join(" ")} could not run: ${cause.message}`,
            })
        )
      );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new RegistrationError({
          message: `${command} ${args.join(" ")} exited with ${exitCode}. No other configuration was changed.`,
        })
      );
    }
  });

const describeEntry = (entry: ExistingEntry): string =>
  `${entry.location} runs ${[entry.spec.command, ...entry.spec.args].join(" ")}`;

const precedenceNotesClaude = (
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
    const notes = precedenceNotesClaude(request.scope, entries, request.spec);
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

const precedenceNotesCodex = (
  request: RegistrationRequest,
  other: ExistingEntry | undefined,
  trusted: boolean
): string[] => {
  const notes: string[] = [];
  if (request.scope === "project" && !trusted) {
    notes.push(
      `Codex reads ${codexProjectConfigPath(request.projectDirectory)} only for trusted projects. Codex asks to trust this directory the next time it starts here; until then, sessions here use the user registration if one exists.`
    );
  }
  if (
    other !== undefined &&
    describeDifferences(other.spec, request.spec, other.extras).length > 0
  ) {
    notes.push(
      request.scope === "user"
        ? `In this project, ${describeEntry(other)} and takes precedence over the user registration while the project is trusted. Other projects use the user registration.`
        : `${describeEntry(other)}. This trusted project uses its own registration instead; other projects keep the user registration.`
    );
  }
  return notes;
};

const registerCodex = (request: RegistrationRequest) =>
  Effect.gen(function* registerWithCodex() {
    const fileSystem = yield* FileSystem.FileSystem;
    const userPath = codexUserConfigPath(request.env, request.home);
    const projectPath = codexProjectConfigPath(request.projectDirectory);
    const userText = yield* readOptionalText(userPath);
    const userEntry = Option.getOrUndefined(yield* readCodexEntry(userPath));
    const projectEntry = Option.getOrUndefined(
      yield* readCodexEntry(projectPath)
    );
    const trusted = codexTrustsProject(userText, request.projectDirectory);
    const existing = request.scope === "user" ? userEntry : projectEntry;
    const location = request.scope === "user" ? userPath : projectPath;
    const notes = precedenceNotesCodex(
      request,
      request.scope === "user" ? projectEntry : userEntry,
      trusted
    );
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
    }
    if (request.scope === "user") {
      // `codex mcp add` replaces a same-name entry wholesale, which is why the
      // check above runs first and asks before any replacement.
      yield* commandOutcome(
        "codex",
        [
          "mcp",
          "add",
          SERVER_NAME,
          ...Object.entries(request.spec.env).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          "--",
          request.spec.command,
          ...request.spec.args,
        ],
        { cwd: request.projectDirectory, env: request.env }
      );
    } else {
      const current = Option.getOrElse(
        yield* readOptionalText(projectPath),
        () => ""
      );
      const next = yield* Effect.try({
        catch: (cause) =>
          new RegistrationError({
            message: `Could not update ${projectPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        try: () =>
          replaceTomlTable(current, TABLE_PATH, codexTable(request.spec)),
      });
      yield* fileSystem
        .makeDirectory(path.dirname(projectPath), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RegistrationError({
                message: `Could not create ${path.dirname(projectPath)}: ${cause.message}`,
              })
          )
        );
      yield* fileSystem.writeFileString(projectPath, next).pipe(
        Effect.mapError(
          (cause) =>
            new RegistrationError({
              message: `Could not write ${projectPath}: ${cause.message}`,
            })
        )
      );
    }
    const written = Option.getOrUndefined(yield* readCodexEntry(location));
    if (
      written === undefined ||
      describeDifferences(written.spec, request.spec, written.extras).length > 0
    ) {
      return yield* Effect.fail(
        new RegistrationError({
          message: `${location} does not hold the expected entry after registration.`,
        })
      );
    }
    return {
      _tag: existing === undefined ? "registered" : "replaced",
      location,
      notes,
    } satisfies RegistrationOutcome;
  });

export const register = (request: RegistrationRequest) =>
  request.agent === "claude" ? registerClaude(request) : registerCodex(request);
