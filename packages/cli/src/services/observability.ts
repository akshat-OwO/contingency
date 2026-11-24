import os from "node:os";
import path from "node:path";

import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Logger,
  Option,
  Ref,
  References,
  Schema,
  Tracer,
} from "effect";
import type { LogLevel, Scope } from "effect";
import { CliConfig, Flag, GlobalFlag } from "effect/cli";
import { constVoid } from "effect/Function";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import {
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability";

import packageJson from "../../package.json" with { type: "json" };
import {
  DIAGNOSTIC_LOG_DIRECTORY,
  formatCompact,
  formatPlain,
  makeDiagnosticLogFile,
  toSafeRecord,
} from "./diagnostic-log.ts";
import { GLOBAL_CATALOG_DIRECTORY } from "./flow-catalog.ts";
import { SETTINGS_LOG_LEVELS } from "./settings.ts";
import { makeShareSafeTracer, ShareSafeSpan } from "./share-safe-tracer.ts";

/**
 * Owns every place this process's logs and spans go. Commands, services and
 * workers only call `Effect.log*`, annotate, and name spans; this module
 * decides what reaches the terminal, writes the Diagnostic Log, and exports
 * spans when the user opts in.
 *
 * - The terminal shows Warn and above as short sentences on stderr. At Debug,
 *   it switches to one compact line per record.
 * - The Diagnostic Log records Debug and above in `~/.contingency/logs`,
 *   whatever the terminal shows.
 * - Spans and metrics go to an OTLP collector only when the environment or the
 *   user's own `config.json` names one.
 */

/** Log levels a user can choose, as the flag, environment, and file spell them. */
export const LOG_LEVELS = SETTINGS_LOG_LEVELS;
export type LogLevelName = (typeof LOG_LEVELS)[number];

const LEVEL_BY_NAME: Readonly<Record<LogLevelName, LogLevel.LogLevel>> = {
  debug: "Debug",
  error: "Error",
  fatal: "Fatal",
  info: "Info",
  none: "None",
  trace: "Trace",
  warn: "Warn",
};

export const toLogLevel = (name: LogLevelName): LogLevel.LogLevel =>
  LEVEL_BY_NAME[name];

/** The terminal's level when nothing chooses one. */
export const DEFAULT_TERMINAL_LEVEL: LogLevel.LogLevel = "Warn";

const SEVERITY_ORDER: readonly LogLevel.LogLevel[] = [
  "All",
  "Trace",
  "Debug",
  "Info",
  "Warn",
  "Error",
  "Fatal",
  "None",
];

/** Whether a record at `level` passes a sink set to `minimum`. */
export const passes = (
  level: LogLevel.LogLevel,
  minimum: LogLevel.LogLevel
): boolean =>
  minimum !== "None" &&
  SEVERITY_ORDER.indexOf(level) >= SEVERITY_ORDER.indexOf(minimum);

/** Whether a terminal at `level` uses the compact `--debug` format. */
export const isVerbose = (level: LogLevel.LogLevel): boolean =>
  level !== "None" &&
  SEVERITY_ORDER.indexOf(level) <= SEVERITY_ORDER.indexOf("Debug");

/** The `log.level` Setting (ADR 0063): environment, project file, user file. */
export const logLevelConfig = Config.Literals(
  LOG_LEVELS,
  "CONTINGENCY_LOG_LEVEL"
).pipe(Config.option);

/* -------------------------------------------------------------------------- */
/* Global flags                                                               */
/* -------------------------------------------------------------------------- */

/** `--debug`: Debug records on the terminal, in the compact format. */
export const DebugFlag = GlobalFlag.Setting("debug")({
  flag: Flag.Boolean("debug").pipe(
    Flag.withDescription(
      "Show Debug records on the terminal, one line each. Same as --log-level debug."
    ),
    Flag.withDefault(false)
  ),
});

/**
 * `--log-level`, which replaces Effect's built-in flag. The built-in sets the
 * process's minimum level, which would also thin the Diagnostic Log; this one
 * sets only what the terminal shows.
 */
export const LogLevelFlag = GlobalFlag.Setting("log-level")({
  flag: Flag.Literals("log-level", LOG_LEVELS).pipe(
    Flag.withDescription(
      "The lowest level the terminal shows. The Diagnostic Log always records debug."
    ),
    Flag.optional
  ),
});

/** Effect's built-ins without its `--log-level`, which `LogLevelFlag` replaces. */
export const cliConfigLayer = CliConfig.layer({
  builtIns: GlobalFlag.BuiltIns.filter((flag) => flag !== GlobalFlag.LogLevel),
});

/** The level a launch's flags choose, if any. `--log-level` outranks `--debug`. */
export const flagLevel = (input: {
  readonly debug: boolean;
  readonly logLevel: Option.Option<LogLevelName>;
}): Option.Option<LogLevel.LogLevel> => {
  if (Option.isSome(input.logLevel)) {
    return Option.some(toLogLevel(input.logLevel.value));
  }
  return input.debug ? Option.some("Debug") : Option.none();
};

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

interface TerminalState {
  readonly level: LogLevel.LogLevel;
  /** A flag chose the level, so no Settings file may change it. */
  readonly pinned: boolean;
  /** Scopes that hand the terminal to another program, such as an agent. */
  readonly silenced: number;
}

export class Observability extends Context.Service<
  Observability,
  {
    /** The level the terminal shows now. */
    readonly terminalLevel: Effect.Effect<LogLevel.LogLevel>;
    /** Applies a launch's flags; a chosen level outranks every Setting. */
    readonly applyFlags: (
      level: Option.Option<LogLevel.LogLevel>
    ) => Effect.Effect<void>;
    /**
     * Applies the `log.level` Setting from a command's Settings. It changes
     * nothing when a flag already chose the level.
     */
    readonly applySettings: (
      provider: ConfigProvider.ConfigProvider
    ) => Effect.Effect<void>;
    /** Keeps the terminal quiet while the scope is open; the file still records. */
    readonly silenceTerminal: Effect.Effect<void, never, Scope.Scope>;
    /** This process's Diagnostic Log directory. */
    readonly logDirectory: string;
  }
>()("contingency/Observability") {}

/** Where the Diagnostic Log lives for a home directory. */
export const diagnosticLogDirectory = (home: string = os.homedir()) =>
  path.join(home, GLOBAL_CATALOG_DIRECTORY, DIAGNOSTIC_LOG_DIRECTORY);

export interface ObservabilityOptions {
  /** Starting level, before a command reads its flags and Settings. */
  readonly level: LogLevel.LogLevel;
  readonly home: string;
  readonly pid: number;
  readonly now: Date;
  /** Writes one terminal line; stderr in production. */
  readonly writeTerminal: (line: string) => void;
  readonly colors: boolean;
  /** `false` keeps a test from writing a Diagnostic Log. */
  readonly logFile: boolean;
}

/** Starting terminal level from the environment alone. */
const decodeLevelName = Schema.decodeUnknownOption(Schema.Literals(LOG_LEVELS));

export const environmentLevel = (
  env: Readonly<Record<string, string | undefined>>
): LogLevel.LogLevel =>
  decodeLevelName(env.CONTINGENCY_LOG_LEVEL?.toLowerCase()).pipe(
    Option.map(toLogLevel),
    Option.getOrElse(() => DEFAULT_TERMINAL_LEVEL)
  );

/**
 * The process's loggers and the service that steers them. Every record
 * reaches the Diagnostic Log; the terminal applies its own level.
 */
export const makeObservabilityLayer = (options: ObservabilityOptions) =>
  Layer.effectContext(
    Effect.gen(function* makeObservability() {
      const state = yield* Ref.make<TerminalState>({
        level: options.level,
        pinned: false,
        silenced: 0,
      });
      const terminal = Logger.make((record) => {
        // A logger runs synchronously inside the logging fiber.
        const current = Ref.getUnsafe(state);
        if (current.silenced > 0 || !passes(record.logLevel, current.level)) {
          return;
        }
        const safe = toSafeRecord(record, options.home);
        options.writeTerminal(
          isVerbose(current.level)
            ? formatCompact(safe, { colors: options.colors, isoTime: false })
            : formatPlain(safe)
        );
      });
      const logDirectory = diagnosticLogDirectory(options.home);
      const file = options.logFile
        ? yield* makeDiagnosticLogFile({
            directory: logDirectory,
            format: (record) =>
              formatCompact(toSafeRecord(record, options.home), {
                colors: false,
                isoTime: true,
              }),
            now: options.now,
            pid: options.pid,
          })
        : undefined;
      // Logs inside a span become its events, through the same allowlist.
      const spanEvents = Logger.make((record) => {
        const { span } = record.fiber.cache;
        if (span === undefined || span._tag !== "Span") {
          return;
        }
        const safe = toSafeRecord(record, options.home);
        const time = BigInt(record.date.getTime()) * 1_000_000n;
        const fields = {
          ...Object.fromEntries(safe.fields),
          "effect.logLevel": record.logLevel.toUpperCase(),
        };
        if (span instanceof ShareSafeSpan) {
          span.safeEvent(safe.message, time, fields);
        } else {
          span.event(safe.message, time, fields);
        }
      });
      const service = Observability.of({
        applyFlags: (level) =>
          Option.isSome(level)
            ? Ref.set(state, {
                ...Ref.getUnsafe(state),
                level: level.value,
                pinned: true,
              })
            : Effect.void,
        applySettings: (provider) =>
          logLevelConfig.parse(provider).pipe(
            Effect.flatMap((name) =>
              Ref.update(state, (current) =>
                current.pinned || Option.isNone(name)
                  ? current
                  : { ...current, level: toLogLevel(name.value) }
              )
            ),
            // Settings decoding already failed startup for an invalid file;
            // an unreadable value here leaves the level as it was.
            Effect.orElseSucceed(constVoid)
          ),
        logDirectory,
        silenceTerminal: Effect.acquireRelease(
          Ref.update(state, (current) => ({
            ...current,
            silenced: current.silenced + 1,
          })),
          () =>
            Ref.update(state, (current) => ({
              ...current,
              silenced: current.silenced - 1,
            }))
        ),
        terminalLevel: Ref.get(state).pipe(
          Effect.map((current) => current.level)
        ),
      });
      return Context.make(Observability, service).pipe(
        Context.add(
          Logger.CurrentLoggers,
          new Set(
            file === undefined
              ? [terminal, spanEvents]
              : [terminal, file, spanEvents]
          )
        ),
        // Every record reaches the file; each sink applies its own level.
        Context.add(References.MinimumLogLevel, "Debug")
      );
    })
  );

/**
 * OTLP span and metric export, only when `OTEL_EXPORTER_OTLP_ENDPOINT` (or a
 * signal-specific endpoint) is set in the environment or `telemetry` names one
 * in the user's own `config.json`. Logs are not exported: they reach spans as
 * events, through the allowlist.
 */
export const makeTelemetryLayer = (
  provider: ConfigProvider.ConfigProvider,
  options: {
    readonly home: string;
    /** The collector's transport; `fetch` in production. */
    readonly httpClient?: Layer.Layer<HttpClient.HttpClient> | undefined;
  }
) => {
  const resource = {
    serviceName: "contingency",
    serviceVersion: packageJson.version,
  };
  // Spans leave the machine, so they hold no more than the Diagnostic Log.
  const shareSafe = Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* wrapTracer() {
      return makeShareSafeTracer(yield* Effect.tracer, options.home);
    })
  );
  return shareSafe.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OtlpTracer.layerFromConfig({ resource }),
        OtlpMetrics.layerFromConfig({ resource })
      )
    ),
    Layer.provide(
      Layer.mergeAll(
        options.httpClient ?? FetchHttpClient.layer,
        OtlpSerialization.layerJson
      )
    ),
    Layer.provide(
      ConfigProvider.layer(
        // An endpoint is the opt-in; OTLP is then the exporter, as the
        // OpenTelemetry specification defaults it.
        ConfigProvider.orElse(
          provider,
          ConfigProvider.fromEnvRecord({
            OTEL_METRICS_EXPORTER: "otlp",
            OTEL_TRACES_EXPORTER: "otlp",
          })
        )
      )
    )
  );
};

/**
 * Applies a launch's `--debug` and `--log-level`. Every subcommand runs after
 * it, so its records use the launch's level from the first one.
 */
export const applyLaunchFlags = Effect.gen(function* applyLaunchFlagsEffect() {
  const observability = yield* Observability;
  const debug = yield* DebugFlag;
  const logLevel = yield* LogLevelFlag;
  yield* observability.applyFlags(flagLevel({ debug, logLevel }));
});

/**
 * Applies the `log.level` Setting a command read. The root applies the
 * user's own file first, so a command that reads no Catalog Root honours it.
 */
export const applySettingsLogLevel = Effect.fnUntraced(
  function* applySettingsLogLevel(provider: ConfigProvider.ConfigProvider) {
    const observability = yield* Observability;
    yield* observability.applySettings(provider);
  }
);
