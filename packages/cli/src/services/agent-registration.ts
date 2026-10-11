import { Data, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { AgentHarnesses } from "./agent-harness.ts";
import type { HarnessId } from "./agent-harness.ts";

/**
 * Permanent MCP registration after onboarding (ADR 0049).
 *
 * Every write goes through a check first: an equivalent existing entry is
 * kept, a different one is reported and replaced only on an explicit request,
 * and unrelated configuration is never rewritten. Each Agent Harness owns how
 * its configuration is read and written; this module holds what they share.
 */

export const SERVER_NAME = "contingency";

export type RegistrationScope = "project" | "user";

/** The stdio server a registration launches. */
export interface ServerSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutSeconds?: number | undefined;
}

export class RegistrationError extends Data.TaggedError("RegistrationError")<{
  readonly message: string;
}> {}

/**
 * The server a permanent registration starts. It always binds an available
 * Workspace port and names its harness, so the process finds the current
 * project the way that harness reports it, and it carries the original
 * onboarding directory only as the fallback.
 */
export const baseRegistrationServerSpec = (input: {
  readonly fallbackDirectory: string;
  readonly harness: HarnessId;
  readonly invocation: {
    readonly args: readonly string[];
    readonly command: string;
  };
}): ServerSpec => ({
  args: [
    ...input.invocation.args,
    "mcp",
    "--agent",
    input.harness,
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
  if (existing.startupTimeoutSeconds !== wanted.startupTimeoutSeconds) {
    differences.push(
      `startup_timeout_sec is ${existing.startupTimeoutSeconds ?? "unset"}; Contingency would use ${wanted.startupTimeoutSeconds ?? "the default"}`
    );
  }
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

/**
 * A Contingency server entry, reduced to what registration compares. Struct
 * decoding ignores every other key, so unrelated servers and settings are
 * never parsed, and never rewritten.
 */
export const ServerEntry = Schema.Struct({
  args: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  startup_timeout_sec: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
});
export type ServerEntryValue = typeof ServerEntry.Type;

export interface ExistingEntry {
  /** Settings outside command, args, and env that change behavior. */
  readonly extras: readonly string[];
  readonly spec: ServerSpec;
  /** Where the entry lives, for messages. */
  readonly location: string;
}

const readError = (filePath: string) => (cause: { readonly message: string }) =>
  new RegistrationError({
    message: `Could not read ${filePath}: ${cause.message}`,
  });

/** A file's text, or none when it does not exist. */
export const readOptionalText = (filePath: string) =>
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
export const readJsonConfig = <S extends Schema.Constraint>(
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

export interface RegistrationRequest {
  readonly harness: HarnessId;
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

export const commandOutcome = (
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
          message: `${command} ${args.join(" ")} exited with ${exitCode}.`,
        })
      );
    }
  });

export const describeEntry = (entry: ExistingEntry): string =>
  `${entry.location} runs ${[entry.spec.command, ...entry.spec.args].join(" ")}`;

/** Register through the requested harness, which owns its configuration. */
export const register = (request: RegistrationRequest) =>
  Effect.gen(function* registerWithHarness() {
    const harnesses = yield* AgentHarnesses;
    return yield* harnesses[request.harness].register(request);
  });
