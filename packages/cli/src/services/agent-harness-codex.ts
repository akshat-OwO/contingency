import path from "node:path";

import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
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
  readOptionalText,
} from "./agent-registration.ts";
import type {
  ExistingEntry,
  RegistrationOutcome,
  RegistrationRequest,
  ServerSpec,
} from "./agent-registration.ts";
import { findTomlTable, replaceTomlTable, tomlString } from "./toml-table.ts";

/**
 * Codex as an Agent Harness.
 *
 * A session receives the MCP server through `-c` TOML overrides, which write
 * no configuration and leave authentication, model, and permission settings
 * alone. User configuration is changed with `codex mcp add`. Both scopes then
 * get their startup timeout through a text edit of one table, preserving
 * unrelated configuration. Codex starts stdio servers in its current working
 * directory, which names the current project.
 */

export const CODEX_STARTUP_TIMEOUT_SECONDS = 60;

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
        startupTimeoutSeconds: entry.startup_timeout_sec,
      },
    } satisfies ExistingEntry);
  });

export const codexTable = (spec: ServerSpec): string => {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
  ];
  if (spec.startupTimeoutSeconds !== undefined) {
    lines.push(`startup_timeout_sec = ${spec.startupTimeoutSeconds}`);
  }
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
 * `extra` holds arguments the user passed after `--`, such as `exec` for a
 * non-interactive run; the initial message stays last as the prompt.
 */
const codexArguments = (request: LaunchRequest): string[] => [
  ...codexMcpOverrides(request.spec),
  ...request.extra,
  request.message,
];

const precedenceNotes = (
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
    const notes = precedenceNotes(
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
    }
    // The CLI has no persistent startup-timeout option. Add it to the entry
    // it just wrote, using the same text-preserving edit as project scope.
    const current = Option.getOrElse(
      yield* readOptionalText(location),
      () => ""
    );
    const next = yield* Effect.try({
      catch: (cause) =>
        new RegistrationError({
          message: `Could not update ${location}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      try: () =>
        replaceTomlTable(current, TABLE_PATH, codexTable(request.spec)),
    });
    yield* fileSystem
      .makeDirectory(path.dirname(location), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RegistrationError({
              message: `Could not create ${path.dirname(location)}: ${cause.message}`,
            })
        )
      );
    yield* fileSystem.writeFileString(location, next).pipe(
      Effect.mapError(
        (cause) =>
          new RegistrationError({
            message: `Could not write ${location}: ${cause.message}`,
          })
      )
    );
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

/** The server a permanent Codex registration starts. */
export const codexRegistrationServerSpec = (
  input: Parameters<AgentHarness["registrationServerSpec"]>[0]
): ServerSpec => ({
  ...baseRegistrationServerSpec({ ...input, harness: "codex" }),
  startupTimeoutSeconds: CODEX_STARTUP_TIMEOUT_SECONDS,
});

export class CodexHarness extends Context.Service<CodexHarness, AgentHarness>()(
  "@contingency/AgentHarness/codex"
) {}

export const CodexHarnessLive = Layer.effect(
  CodexHarness,
  Effect.gen(function* makeCodexHarness() {
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    >();
    return {
      // A Claude variable inherited by a Codex process never redirects it.
      currentProjectDirectory: ({ cwd }) => Effect.succeed(cwd),
      id: "codex",
      install:
        "Install Codex with `npm install -g @openai/codex` (see https://developers.openai.com/codex).",
      label: "Codex",
      launchPlan: (request) =>
        Effect.succeed({
          args: codexArguments(request),
          command: request.executable,
          env: {},
        }),
      readiness: (pathVariable) =>
        versionReadiness({
          binary: "codex",
          major: 0,
          pathVariable,
          product: /^codex-cli /u,
        }).pipe(Effect.provideContext(context)),
      register: (request) =>
        registerCodex(request).pipe(Effect.provideContext(context)),
      registrationServerSpec: codexRegistrationServerSpec,
      verifiedVersion: "0.160.0",
    } satisfies AgentHarness;
  })
);
