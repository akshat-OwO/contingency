import path from "node:path";

import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  stripComments,
} from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";

import { versionReadiness } from "./agent-harness.ts";
import type { AgentHarness, LaunchRequest } from "./agent-harness.ts";
import { AgentLaunchError } from "./agent-launch-error.ts";
import {
  SERVER_NAME,
  RegistrationError,
  baseRegistrationServerSpec,
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

/**
 * OpenCode V2 as an Agent Harness.
 *
 * A session runs the TUI with `--standalone` and receives the MCP server
 * through `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the user's
 * configuration without writing any file. The shared background service reads
 * its environment once, at its own start, so it would never see that content;
 * a private server per launch also gives each Agent Session its own
 * Contingency process.
 *
 * Registration edits the JSONC configuration directly. `opencode mcp add`
 * cannot write `codemode` or a startup timeout, and it reformats sibling
 * entries; a single JSONC edit leaves every other byte, comments included, as
 * written. OpenCode starts stdio servers in the session's directory, even from
 * the background service, so that directory names the current project.
 */

export const OPENCODE_STARTUP_TIMEOUT_SECONDS = 60;

const CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;

/** OpenCode's global configuration directory. */
export const opencodeUserConfigDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string => {
  const configured = env.OPENCODE_CONFIG_DIR?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(
    xdg === undefined || xdg.length === 0 ? path.join(home, ".config") : xdg,
    "opencode"
  );
};

/** Every file OpenCode reads for user scope, in the order `opencode mcp add` picks one. */
export const opencodeUserConfigPaths = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): string[] =>
  CONFIG_FILES.map((name) =>
    path.join(opencodeUserConfigDirectory(env, home), name)
  );

/** Every file OpenCode reads for project scope, in the order `opencode mcp add` picks one. */
export const opencodeProjectConfigPaths = (
  projectDirectory: string
): string[] => [
  ...CONFIG_FILES.map((name) => path.join(projectDirectory, name)),
  ...CONFIG_FILES.map((name) => path.join(projectDirectory, ".opencode", name)),
];

const ENTRY_PATH = ["mcp", "servers", SERVER_NAME] as const;

/** One local server entry in OpenCode's configuration. */
const OpencodeEntry = Schema.Struct({
  codemode: Schema.optional(Schema.Boolean),
  command: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  timeout: Schema.optional(
    Schema.Struct({ startup: Schema.optional(Schema.Number) })
  ),
  type: Schema.optional(Schema.String),
});

/** The part of an OpenCode configuration document Contingency reads. */
const OpencodeConfig = Schema.Struct({
  mcp: Schema.optional(
    Schema.Struct({
      servers: Schema.optional(
        Schema.Struct({ [SERVER_NAME]: Schema.optional(Schema.Unknown) })
      ),
    })
  ),
});

/** The entry Contingency writes, for a session or a registration. */
export interface OpencodeServerEntry {
  readonly codemode: false;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout?: { readonly startup: number };
  readonly type: "local";
}

export const opencodeEntry = (spec: ServerSpec): OpencodeServerEntry => {
  const entry: OpencodeServerEntry = {
    codemode: false,
    command: [spec.command, ...spec.args],
    environment: spec.env,
    type: "local",
  };
  if (spec.startupTimeoutSeconds === undefined) {
    return entry;
  }
  return { ...entry, timeout: { startup: spec.startupTimeoutSeconds * 1000 } };
};

/** A JSONC document as a value, or why it is not one. */
const parseJsonc = (
  text: string
): { ok: true; value: unknown } | { ok: false; reason: string } => {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
  });
  const [first] = errors;
  if (first !== undefined) {
    return {
      ok: false,
      reason: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  return { ok: true, value: value ?? {} };
};

const unreadableEntry = "the entry is not a local command Contingency can read";

/**
 * The `mcp.servers.contingency` entry in one OpenCode file, or none. A file
 * that is not readable JSONC is a refusal, never a guess.
 */
export const opencodeEntryFromJsonc = (text: string, location: string) =>
  Effect.gen(function* readOpencodeEntry() {
    const parsed = parseJsonc(text);
    const config = parsed.ok
      ? Schema.decodeUnknownOption(OpencodeConfig)(parsed.value)
      : Option.none();
    if (Option.isNone(config)) {
      return yield* Effect.fail(
        new RegistrationError({
          message: `${location} is not JSONC Contingency can read${parsed.ok ? "" : ` (${parsed.reason})`}, so Contingency will not change it.`,
        })
      );
    }
    const raw = config.value.mcp?.servers?.[SERVER_NAME];
    if (raw === undefined) {
      return Option.none<ExistingEntry>();
    }
    const decoded = Schema.decodeUnknownOption(OpencodeEntry)(raw);
    const [command, ...args] = Option.isSome(decoded)
      ? (decoded.value.command ?? [])
      : [];
    if (Option.isNone(decoded) || command === undefined) {
      return Option.some({
        extras: [unreadableEntry],
        location,
        spec: { args: [], command: "", env: {} },
      } satisfies ExistingEntry);
    }
    const entry = decoded.value;
    const type = entry.type ?? "local";
    const extras = [
      ...(type === "local" ? [] : [`type is ${type}, not local`]),
      ...(entry.disabled === true ? ["disabled is set to true"] : []),
      ...(entry.cwd === undefined
        ? []
        : [`cwd is set to ${JSON.stringify(entry.cwd)}`]),
      ...(entry.codemode === false
        ? []
        : [
            `codemode is ${entry.codemode === undefined ? "unset" : "true"}; Contingency would set it to false so its tools stay native`,
          ]),
    ];
    const startup = entry.timeout?.startup;
    return Option.some({
      extras,
      location,
      spec: {
        args,
        command,
        env: entry.environment ?? {},
        startupTimeoutSeconds:
          startup === undefined ? undefined : startup / 1000,
      },
    } satisfies ExistingEntry);
  });

/** Indentation and line endings to match, so a new entry looks hand-written. */
const formattingOf = (text: string) => {
  const indent = /^(?<indent>[ \t]+)\S/mu.exec(text)?.groups?.indent;
  const tabs = indent?.startsWith("\t") === true;
  return {
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertSpaces: !tabs,
    tabSize: indent === undefined || tabs ? 2 : indent.length,
    unit: tabs ? "\t" : " ".repeat(indent?.length ?? 2),
  };
};

const lineStart = (text: string, offset: number): number =>
  text.lastIndexOf("\n", offset - 1) + 1;

/** Whether a comma follows the last member before the closing brace. */
const hasTrailingComma = (between: string): boolean =>
  stripComments(between).includes(",");

/**
 * The entry as a new member of `parent`, on its own line before the closing
 * brace, nested under the `keys` that do not exist yet; or none when the
 * object is not laid out one member per line. jsonc-parser's own insertion
 * reformats the line it inserts on, which holds a sibling entry.
 */
const insertMember = (
  text: string,
  parent: Node,
  keys: readonly [string, ...string[]],
  entry: OpencodeServerEntry
): string | undefined => {
  const last = parent.children?.at(-1);
  const close = parent.offset + parent.length - 1;
  const closeLine = lineStart(text, close);
  if (
    last === undefined ||
    text.slice(closeLine, close).trim().length > 0 ||
    lineStart(text, last.offset) === lineStart(text, parent.offset)
  ) {
    return undefined;
  }
  const { eol, unit } = formattingOf(text);
  const indent =
    /^[ \t]*/u.exec(text.slice(lineStart(text, last.offset)))?.[0] ?? "";
  const lastEnd = last.offset + last.length;
  const trailing = hasTrailingComma(text.slice(lastEnd, close));
  const [key, ...inner] = keys;
  let value = JSON.stringify(entry, undefined, unit);
  for (const name of inner.toReversed()) {
    value = `{\n${unit}${JSON.stringify(name)}: ${value.replaceAll("\n", `\n${unit}`)}\n}`;
  }
  const body = value.replaceAll("\n", `${eol}${indent}`);
  const member = `${indent}${JSON.stringify(key)}: ${body}${trailing ? "," : ""}${eol}`;
  return `${text.slice(0, lastEnd)}${trailing ? "" : ","}${text.slice(lastEnd, closeLine)}${member}${text.slice(closeLine)}`;
};

/** `text` with the Contingency entry set to `value`; every other byte is kept. */
export const withOpencodeEntry = (
  text: string,
  entry: OpencodeServerEntry
): string => {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (
    root !== undefined &&
    findNodeAtLocation(root, [...ENTRY_PATH]) === undefined
  ) {
    // Add the entry under the deepest object that already exists.
    let parent = root;
    let depth = 0;
    for (const key of ENTRY_PATH.slice(0, -1)) {
      const child = findNodeAtLocation(parent, [key]);
      if (child?.type !== "object") {
        break;
      }
      parent = child;
      depth += 1;
    }
    const [key, ...inner] = ENTRY_PATH.slice(depth);
    const inserted =
      parent.type === "object" && key !== undefined
        ? insertMember(text, parent, [key, ...inner], entry)
        : undefined;
    if (inserted !== undefined) {
      return inserted;
    }
  }
  // Replacing an existing value reformats only that value.
  const next = applyEdits(
    text,
    modify(text, [...ENTRY_PATH], entry, {
      formattingOptions: formattingOf(text),
    })
  );
  return text.length === 0 ? `${next}\n` : next;
};

/**
 * The session-only configuration: the user's own `OPENCODE_CONFIG_CONTENT`,
 * when set, with the Contingency entry added.
 */
export const opencodeConfigContent = (
  spec: ServerSpec,
  inherited: string | undefined
) =>
  Effect.gen(function* buildConfigContent() {
    if (inherited === undefined || inherited.trim().length === 0) {
      return JSON.stringify({
        mcp: { servers: { [SERVER_NAME]: opencodeEntry(spec) } },
      });
    }
    const parsed = parseJsonc(inherited);
    if (
      !parsed.ok ||
      Option.isNone(Schema.decodeUnknownOption(OpencodeConfig)(parsed.value))
    ) {
      return yield* Effect.fail(
        new AgentLaunchError({
          message: `OPENCODE_CONFIG_CONTENT is set but is not a JSONC object${parsed.ok ? "" : ` (${parsed.reason})`}, so Contingency cannot add its server to it. Fix or unset it, then try again.`,
        })
      );
    }
    return withOpencodeEntry(inherited, opencodeEntry(spec));
  });

/**
 * Arguments that would connect this launch to a server other than its own
 * private one, which never sees the session-only Contingency entry.
 */
const sharedServerArgument = (extra: readonly string[]): string | undefined =>
  extra.find(
    (argument) => argument === "--server" || argument.startsWith("--server=")
  );

const opencodeLaunchPlan = (request: LaunchRequest) =>
  Effect.gen(function* planOpencode() {
    const shared = sharedServerArgument(request.extra);
    if (shared !== undefined) {
      return yield* Effect.fail(
        new AgentLaunchError({
          message: `contingency start runs OpenCode with --standalone and does not accept ${shared}. A shared OpenCode server reads its configuration once, when it starts, so it would never see this session's Contingency connection; --standalone gives each launch its own server and its own Contingency process. Remove ${shared} and try again.`,
        })
      );
    }
    return {
      // `extra` holds arguments the user passed after `--`. The initial
      // message goes through `--prompt`, so it stays a single argument.
      args: [...request.extra, "--standalone", "--prompt", request.message],
      command: request.executable,
      env: {
        // A cold `npx` run downloads the CLI before the server answers.
        OPENCODE_CONFIG_CONTENT: yield* opencodeConfigContent(
          {
            ...request.spec,
            startupTimeoutSeconds: OPENCODE_STARTUP_TIMEOUT_SECONDS,
          },
          request.env.OPENCODE_CONFIG_CONTENT
        ),
      },
    };
  });

interface ConfigFile {
  readonly entry: ExistingEntry | undefined;
  readonly exists: boolean;
  readonly path: string;
  readonly text: string;
}

const readConfigFile = (filePath: string) =>
  Effect.gen(function* readOpencodeFile() {
    const text = yield* readOptionalText(filePath);
    if (Option.isNone(text)) {
      return {
        entry: undefined,
        exists: false,
        path: filePath,
        text: "",
      } satisfies ConfigFile;
    }
    return {
      entry: Option.getOrUndefined(
        yield* opencodeEntryFromJsonc(text.value, filePath)
      ),
      exists: true,
      path: filePath,
      text: text.value,
    } satisfies ConfigFile;
  });

/** The file `opencode mcp add` would write: the first that exists, or the first candidate. */
const targetFile = (files: readonly ConfigFile[]): ConfigFile | undefined =>
  files.find((file) => file.exists) ?? files[0];

const precedenceNote = (
  target: RegistrationRequest["scope"],
  other: {
    readonly entry: ExistingEntry;
    readonly scope: RegistrationRequest["scope"];
  }
): string => {
  if (other.scope === target) {
    return `${describeEntry(other.entry)}. OpenCode reads that file too; remove one of the two entries so it is clear which one applies.`;
  }
  return target === "user"
    ? `${describeEntry(other.entry)}. OpenCode merges project configuration over the user configuration, so that entry wins in this project; other projects use the user registration.`
    : `${describeEntry(other.entry)}. This project's entry wins here; other projects keep that entry.`;
};

const registerOpencode = (request: RegistrationRequest) =>
  Effect.gen(function* registerWithOpencode() {
    const fileSystem = yield* FileSystem.FileSystem;
    const userFiles = yield* Effect.forEach(
      opencodeUserConfigPaths(request.env, request.home),
      readConfigFile
    );
    const projectFiles = yield* Effect.forEach(
      opencodeProjectConfigPaths(request.projectDirectory),
      readConfigFile
    );
    const scopeFiles = request.scope === "user" ? userFiles : projectFiles;
    const target = targetFile(scopeFiles);
    if (target === undefined) {
      return yield* Effect.die(
        new Error("OpenCode has no configuration path.")
      );
    }
    const existing = target.entry;
    const notes = [
      ...userFiles.map((file) => ({ file, scope: "user" as const })),
      ...projectFiles.map((file) => ({ file, scope: "project" as const })),
    ].flatMap(({ file, scope }) =>
      file.entry === undefined ||
      file.path === target.path ||
      describeDifferences(file.entry.spec, request.spec, file.entry.extras)
        .length === 0
        ? []
        : [precedenceNote(request.scope, { entry: file.entry, scope })]
    );
    const location = target.path;
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
    const next = withOpencodeEntry(target.text, opencodeEntry(request.spec));
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
    const written = (yield* readConfigFile(location)).entry;
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

/** The server a permanent OpenCode registration starts. */
export const opencodeRegistrationServerSpec = (
  input: Parameters<AgentHarness["registrationServerSpec"]>[0]
): ServerSpec => ({
  ...baseRegistrationServerSpec({ ...input, harness: "opencode" }),
  startupTimeoutSeconds: OPENCODE_STARTUP_TIMEOUT_SECONDS,
});

export class OpencodeHarness extends Context.Service<
  OpencodeHarness,
  AgentHarness
>()("@contingency/AgentHarness/opencode") {}

export const OpencodeHarnessLive = Layer.effect(
  OpencodeHarness,
  Effect.gen(function* makeOpencodeHarness() {
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    >();
    return {
      currentProjectDirectory: ({ cwd }) => Effect.succeed(cwd),
      id: "opencode",
      install:
        "Install OpenCode V2 with `npm install -g @opencode/cli` (see https://opencode.ai/docs).",
      label: "OpenCode",
      launchPlan: opencodeLaunchPlan,
      readiness: (pathVariable) =>
        versionReadiness({
          binary: "opencode",
          major: 2,
          pathVariable,
          product: /^opencode v/u,
        }).pipe(Effect.provideContext(context)),
      register: (request) =>
        registerOpencode(request).pipe(Effect.provideContext(context)),
      registrationServerSpec: opencodeRegistrationServerSpec,
      verifiedVersion: "2.0.26",
    } satisfies AgentHarness;
  })
);
