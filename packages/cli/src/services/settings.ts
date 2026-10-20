import os from "node:os";
import path from "node:path";

import {
  ConfigProvider,
  Data,
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
  SchemaIssue,
} from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { CATALOG_DIRECTORY } from "./flow-skill-catalog.ts";

/**
 * Settings read from `config.json` in the Catalog Root and in
 * `~/.contingency` ([ADR 0063](../../../../docs/adr/0063-settings-live-in-a-strict-catalog-root-config.md)).
 *
 * A file never replaces the environment: it becomes two more
 * `ConfigProvider` layers behind it, keyed by the same `CONTINGENCY_*` names,
 * so every `Config` that reads a Setting keeps its own default and parsing.
 */

export const SETTINGS_FILE = "config.json";
export const SETTINGS_SCHEMA_FILE = "config.schema.json";

/**
 * Which tools a server registers. `single-tool` registers only
 * `agent_code_execute` and offers every native tool inside programs (ADR
 * 0059); `native` registers each tool directly.
 */
export const MCP_INTERFACES = ["native", "single-tool"] as const;
export type McpInterface = (typeof MCP_INTERFACES)[number];
/**
 * The #461 evaluation adopted the single tool: no correctness regression and
 * fewer incorrect operation choices for both evaluated models. Native stays
 * available for clients that load tools on demand.
 */
export const DEFAULT_MCP_INTERFACE: McpInterface = "single-tool";

/** How Run videos fast-forward Idle Gaps (ADR 0046). */
export const VIDEO_FAST_FORWARD_MODES = ["capped", "fixed"] as const;

const Port = Schema.Int.check(
  Schema.isBetween({ maximum: 65_535, minimum: 0 })
);

const SystemOneSettings = Schema.Struct({
  first: Schema.optionalKey(
    Schema.Boolean.annotate({
      default: false,
      description:
        "Tell the agent to try a System One Pursuit for each Flow Skill step first. Has no effect without systemOne.url.",
    })
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The System One endpoint: its origin or its full /v1/systemone route. Setting it is consent to send Pursuit requests, and the API key, there. User file only: a project file that sets it fails validation. The API key is environment-only (CONTINGENCY_SYSTEM_ONE_API_KEY).",
    })
  ),
}).annotate({ description: "System One, which pursues delegated sub-goals." });

const McpSettings = Schema.Struct({
  channel: Schema.optionalKey(
    Schema.Boolean.annotate({
      default: false,
      description:
        "Push Claude Code channel events when a session changes. Stdio only.",
    })
  ),
  interface: Schema.optionalKey(
    Schema.Literals(MCP_INTERFACES).annotate({
      default: DEFAULT_MCP_INTERFACE,
      description:
        "Which tools the server registers: single-tool offers every operation inside agent_code_execute; native registers each tool directly.",
    })
  ),
  port: Schema.optionalKey(
    Port.annotate({
      description:
        "The port `contingency mcp` serves the Workspace and /mcp on. 0 binds any free port. Defaults to 7777 from a terminal and 0 otherwise; `contingency start` and registered agents always pass 0.",
    })
  ),
  videoFastForward: Schema.optionalKey(
    Schema.Literals(VIDEO_FAST_FORWARD_MODES).annotate({
      default: "capped",
      description:
        "How Run videos fast-forward Idle Gaps: capped shortens each gap to a ceiling; fixed plays every gap at one speed.",
    })
  ),
}).annotate({ description: "The `contingency mcp` server." });

const WebSettings = Schema.Struct({
  host: Schema.optionalKey(
    Schema.String.annotate({
      default: "127.0.0.1",
      description: "The address `contingency web` binds.",
    })
  ),
  port: Schema.optionalKey(
    Port.annotate({
      default: 7777,
      description: "The port `contingency web` serves the Workspace on.",
    })
  ),
  publicUrl: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The URL a browser opens when the Workspace is reached through a proxy or tunnel. Defaults to the bound address.",
    })
  ),
}).annotate({ description: "The `contingency web` Workspace." });

/** The decoded shape of one `config.json`. */
export const SettingsFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The JSON Schema this file follows. `contingency config init` pins it to the installed CLI version.",
    })
  ),
  mcp: Schema.optionalKey(McpSettings),
  systemOne: Schema.optionalKey(SystemOneSettings),
  web: Schema.optionalKey(WebSettings),
}).annotate({
  description:
    "Contingency Settings. Read from config.json in the Catalog Root and from ~/.contingency/config.json; the environment overrides both.",
  title: "Contingency Settings",
});
export type Settings = typeof SettingsFile.Type;

type Section = Exclude<keyof Settings, "$schema">;

/** The environment variable each file key stands in for. */
export const SETTING_ENV = {
  mcp: {
    channel: "CONTINGENCY_MCP_CHANNEL",
    interface: "CONTINGENCY_MCP_INTERFACE",
    port: "CONTINGENCY_MCP_PORT",
    videoFastForward: "CONTINGENCY_MCP_VIDEO_FAST_FORWARD",
  },
  systemOne: {
    first: "CONTINGENCY_SYSTEM_ONE_FIRST",
    url: "CONTINGENCY_SYSTEM_ONE_URL",
  },
  web: {
    host: "CONTINGENCY_WEB_HOST",
    port: "CONTINGENCY_WEB_PORT",
    publicUrl: "CONTINGENCY_WEB_PUBLIC_URL",
  },
} as const satisfies {
  readonly [S in Section]: {
    readonly [K in keyof NonNullable<Settings[S]>]-?: string;
  };
};

const SETTING_ENTRIES = Object.entries(SETTING_ENV).flatMap(([section, keys]) =>
  Object.entries(keys).map(([key, env]) => ({ env, key, section }))
);

/** Each file path, keyed by the joined `Config` path it answers. */
const FILE_PATH_BY_ENV: ReadonlyMap<string, readonly [string, string]> =
  new Map(
    SETTING_ENTRIES.map(({ env, key, section }) => [env, [section, key]])
  );

/** Each environment variable, keyed by its dotted file key. */
export const SETTING_ENV_BY_KEY: ReadonlyMap<string, string> = new Map(
  SETTING_ENTRIES.map(({ env, key, section }) => [`${section}.${key}`, env])
);

/** A path no file holds, for a `Config` no file key answers. */
const UNMAPPED = ["\u0000"];

/**
 * Probes only for the keys a file may not hold, so each refusal can name the
 * environment variable to use instead.
 */
const ForbiddenProbe = Schema.fromJsonString(
  Schema.Struct({
    catalogRoot: Schema.optionalKey(Schema.Unknown),
    globalCatalogRoot: Schema.optionalKey(Schema.Unknown),
    systemOne: Schema.optionalKey(
      Schema.Struct({
        apiKey: Schema.optionalKey(Schema.Unknown),
        url: Schema.optionalKey(Schema.Unknown),
      })
    ),
  })
);
type ForbiddenKeys = typeof ForbiddenProbe.Type;

/**
 * Settings a file may not hold: a secret, or a Setting that says where the
 * file itself lives. Each is accepted only from the environment.
 */
export const ENVIRONMENT_ONLY_SETTINGS: readonly {
  readonly env: string;
  readonly key: string;
  readonly pointer: string;
  readonly present: (probe: ForbiddenKeys) => boolean;
}[] = [
  {
    env: "CONTINGENCY_SYSTEM_ONE_API_KEY",
    key: "systemOne.apiKey",
    pointer: "/systemOne/apiKey",
    present: (probe) => probe.systemOne?.apiKey !== undefined,
  },
  {
    env: "CONTINGENCY_CATALOG_ROOT",
    key: "catalogRoot",
    pointer: "/catalogRoot",
    present: (probe) => probe.catalogRoot !== undefined,
  },
  {
    env: "CONTINGENCY_GLOBAL_CATALOG_ROOT",
    key: "globalCatalogRoot",
    pointer: "/globalCatalogRoot",
    present: (probe) => probe.globalCatalogRoot !== undefined,
  },
];

/** Which file a decode reads; a project file is shared, a user file is not. */
export type SettingsScope = "project" | "user";

/**
 * Settings a project file may not hold. The System One endpoint receives the
 * machine's API key, so a checked-in file must not choose where that key goes
 * (ADR 0057 scopes the endpoint to the machine).
 */
export const MACHINE_ONLY_SETTINGS: readonly {
  readonly env: string;
  readonly key: string;
  readonly pointer: string;
  readonly present: (probe: ForbiddenKeys) => boolean;
}[] = [
  {
    env: "CONTINGENCY_SYSTEM_ONE_URL",
    key: "systemOne.url",
    pointer: "/systemOne/url",
    present: (probe) => probe.systemOne?.url !== undefined,
  },
];

export const settingsSchemaUrl = (version: string = packageJson.version) =>
  `https://unpkg.com/${packageJson.name}@${version}/${SETTINGS_SCHEMA_FILE}`;

const SCHEMA_URL_PATTERN = new RegExp(
  `^https://unpkg\\.com/${packageJson.name.replace("/", "\\/")}@([^/]+)/${SETTINGS_SCHEMA_FILE.replace(".", "\\.")}$`,
  "u"
);

export class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly message: string;
}> {}

/** RFC 6901: `~` and `/` inside a key are escaped. */
export const jsonPointer = (keys: readonly PropertyKey[]): string =>
  keys
    .map((key) => `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");

const decodeForbidden = Schema.decodeUnknownOption(ForbiddenProbe);
const decodeStrict = Schema.decodeUnknownResult(
  Schema.fromJsonString(SettingsFile),
  { errors: "all", onExcessProperty: "error" }
);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Decodes one file's text strictly. Every failure names the JSON pointer of
 * the offending value, so the message is enough to find and fix it.
 */
export const decodeSettingsFile = (
  text: string,
  scope: SettingsScope
): Result.Result<Settings, readonly string[]> => {
  const failures = new Map<string, string>();
  const probe = decodeForbidden(text);
  for (const setting of ENVIRONMENT_ONLY_SETTINGS) {
    if (Option.exists(probe, setting.present)) {
      failures.set(
        setting.pointer,
        `environment-only; set ${setting.env} instead`
      );
    }
  }
  if (scope === "project") {
    for (const setting of MACHINE_ONLY_SETTINGS) {
      if (Option.exists(probe, setting.present)) {
        failures.set(
          setting.pointer,
          `not allowed in a project file; set ${setting.env} or ${setting.key} in ~/.contingency/config.json instead`
        );
      }
    }
  }
  const decoded = decodeStrict(text);
  if (Result.isSuccess(decoded)) {
    return failures.size === 0
      ? Result.succeed(decoded.success)
      : Result.fail(
          [...failures].map(([pointer, message]) => `${pointer}: ${message}`)
        );
  }
  for (const issue of formatIssues(decoded.failure.issue).issues) {
    // SAFETY: the default formatter's issues carry plain property-key paths
    // (`DefaultIssue` in effect/SchemaIssue), never Standard Schema segments.
    const keys = (issue.path ?? []) as readonly PropertyKey[];
    const pointer = jsonPointer(keys);
    // A forbidden key is also an unknown one; say why it is refused.
    if (!failures.has(pointer)) {
      failures.set(
        pointer,
        issue.message === "Expected no excess property"
          ? "unknown key"
          : issue.message
      );
    }
  }
  return Result.fail(
    [...failures].map(([pointer, message]) => `${pointer || "/"}: ${message}`)
  );
};

const MACHINE_ONLY_ENV = new Set(MACHINE_ONLY_SETTINGS.map(({ env }) => env));

/**
 * One file as a provider answering the `CONTINGENCY_*` paths it stands in
 * for. A project file never answers a machine-only Setting, even when a
 * caller skipped `decodeSettingsFile`.
 */
export const settingsFileProvider = (file: Settings, scope: SettingsScope) =>
  ConfigProvider.mapInput(ConfigProvider.fromUnknown(file), (configPath) => {
    const env = configPath.join("_");
    return scope === "project" && MACHINE_ONLY_ENV.has(env)
      ? UNMAPPED
      : (FILE_PATH_BY_ENV.get(env) ?? UNMAPPED);
  });

export interface SettingsLayers {
  /** Values a command-line flag set for this launch, by variable name. */
  readonly flags?: Readonly<Record<string, string | undefined>> | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly project?: Settings | undefined;
  readonly user?: Settings | undefined;
}

/**
 * Flag, then environment, then project file, then user file. A `Config`'s
 * own default applies when no layer names the Setting.
 */
export const makeSettingsProvider = (layers: SettingsLayers) => {
  let provider = ConfigProvider.orElse(
    ConfigProvider.fromEnvRecord({ ...layers.flags }),
    ConfigProvider.fromEnvRecord({ ...layers.env })
  );
  for (const [file, scope] of [
    [layers.project, "project"],
    [layers.user, "user"],
  ] as const) {
    if (file !== undefined) {
      provider = ConfigProvider.orElse(
        provider,
        settingsFileProvider(file, scope)
      );
    }
  }
  return provider;
};

export const userSettingsPath = (home: string = os.homedir()) =>
  path.join(home, CATALOG_DIRECTORY, SETTINGS_FILE);

export const projectSettingsPath = (catalogRoot: string) =>
  path.join(catalogRoot, SETTINGS_FILE);

/**
 * A warning when `$schema` pins a different CLI version. The running CLI's
 * schema still decides; the editor is merely checking against another one.
 */
export const schemaVersionWarning = (
  file: string,
  settings: Settings
): string | undefined => {
  const version = settings.$schema?.match(SCHEMA_URL_PATTERN)?.[1];
  return version === undefined || version === packageJson.version
    ? undefined
    : `Contingency ${packageJson.version} is reading ${file}, whose $schema names version ${version}.`;
};

const readSettingsFile = (file: string, scope: SettingsScope) =>
  Effect.gen(function* readSettingsFileEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const read = yield* fileSystem.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<string>())
      ),
      Effect.mapError(
        (error) =>
          new SettingsError({
            message: `Contingency could not read ${file}: ${error.message}`,
          })
      )
    );
    if (Option.isNone(read)) {
      return;
    }
    const text = read.value;
    const decoded = decodeSettingsFile(text, scope);
    if (Result.isFailure(decoded)) {
      return yield* new SettingsError({
        message: [
          `Contingency could not use the Settings in ${file}:`,
          ...decoded.failure.map((line) => `  ${line}`),
        ].join("\n"),
      });
    }
    return decoded.success;
  });

export interface LoadedSettings {
  readonly provider: ConfigProvider.ConfigProvider;
  readonly warnings: readonly string[];
}

/**
 * Reads both files and returns the provider every Setting is read through.
 * A missing file is no file; an unreadable or invalid one fails startup.
 */
export const loadSettings = (input: {
  readonly catalogRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags?: Readonly<Record<string, string | undefined>> | undefined;
  readonly home?: string | undefined;
}) =>
  Effect.gen(function* loadSettingsEffect() {
    const projectFile = projectSettingsPath(input.catalogRoot);
    const userFile = userSettingsPath(input.home);
    // A Catalog Root of ~/.contingency makes both one file: the user's own.
    const project =
      projectFile === userFile
        ? undefined
        : yield* readSettingsFile(projectFile, "project");
    const user = yield* readSettingsFile(userFile, "user");
    const warnings = [
      project === undefined
        ? undefined
        : schemaVersionWarning(projectFile, project),
      user === undefined ? undefined : schemaVersionWarning(userFile, user),
    ].filter((warning) => warning !== undefined);
    return {
      provider: makeSettingsProvider({
        env: input.env,
        flags: input.flags,
        project,
        user,
      }),
      warnings,
    } satisfies LoadedSettings;
  });

/**
 * Writes a project file holding only the pinned `$schema`, so an editor
 * completes and checks it. An existing file is never replaced.
 */
export const initSettingsFile = (catalogRoot: string) =>
  Effect.gen(function* initSettingsFileEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const file = projectSettingsPath(catalogRoot);
    const contents = `${JSON.stringify({ $schema: settingsSchemaUrl() }, null, 2)}\n`;
    yield* fileSystem.makeDirectory(catalogRoot, { recursive: true }).pipe(
      Effect.andThen(
        // `wx` refuses an existing file atomically, without a check first.
        fileSystem.writeFileString(file, contents, { flag: "wx" })
      ),
      Effect.mapError(
        (error) =>
          new SettingsError({
            message:
              error.reason._tag === "AlreadyExists"
                ? `${file} already exists; Contingency left it unchanged.`
                : `Contingency could not write ${file}: ${error.message}`,
          })
      )
    );
    return file;
  });
