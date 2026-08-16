import { randomUUID } from "node:crypto";

import type { Flow, Variable } from "@contingency/protocol";
import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Redacted,
  Runtime,
} from "effect";

/**
 * A Variable's value may be supplied as `--secret NAME=value`, or as
 * `--secret NAME` alone, which reads this environment variable instead. argv is
 * visible to every process on a shared machine; an environment variable is not,
 * and CI already supplies secrets that way.
 */
export const VARIABLE_ENVIRONMENT_PREFIX = "CONTINGENCY_SECRET_";

export const variableEnvironmentName = (name: string): string =>
  `${VARIABLE_ENVIRONMENT_PREFIX}${name}`;

/**
 * A misconfigured invocation is the operator's to fix, not a crash. It prints
 * its list of problems and exits 1 without a stack trace.
 */
export class PreflightFailed extends Data.TaggedError("PreflightFailed")<{
  readonly problems: readonly string[];
}> {
  readonly [Runtime.errorReported] = false;
  readonly [Runtime.errorExitCode] = 1;

  get message(): string {
    return [
      `This Flow cannot run yet (${this.problems.length} ${
        this.problems.length === 1 ? "problem" : "problems"
      }):`,
      ...this.problems.map((problem) => `  - ${problem}`),
    ].join("\n");
  }
}

export interface SecretFlag {
  readonly name: string;
  readonly value: string | undefined;
}

/**
 * `NAME=value` supplies a value inline; a bare `NAME` defers to the
 * environment. A value containing `=` is preserved, since only the first
 * separator delimits the name.
 */
export const parseSecretFlag = (entry: string): SecretFlag | undefined => {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const separator = trimmed.indexOf("=");
  if (separator === -1) {
    return { name: trimmed, value: undefined };
  }
  const name = trimmed.slice(0, separator).trim();
  return name.length === 0
    ? undefined
    : { name, value: trimmed.slice(separator + 1) };
};

export interface VariableResolution {
  /** Names whose value must never appear in the persisted Run. */
  readonly secretNames: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

export interface ResolveVariablesOptions<R = never> {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Whether stdin can be prompted. Never true for cron or CI. */
  readonly interactive: boolean;
  /** Checked for writability now, so a Run cannot execute and then fail to persist. */
  readonly outputDirectory: string;
  /** Prompts for one Variable. Only called when `interactive` is true. */
  readonly prompt: (
    variable: Variable
  ) => Effect.Effect<Redacted.Redacted, never, R>;
  readonly retriesEnabled: boolean;
  readonly secrets: readonly string[];
}

export interface PreflightReport {
  readonly resolution: VariableResolution;
  readonly warnings: readonly string[];
}

const declaredVariables = (flow: Flow): readonly Variable[] =>
  flow.contingency?.variables ?? [];

/**
 * Resolve every Variable the Flow declares before a browser opens, and report
 * every problem at once. Preflight fails closed: an unresolvable Variable stops
 * the Run rather than typing an empty string into a login form and surfacing an
 * unresolvable selector eight Steps later (ADR 0009).
 */
export const preflight = <R>(
  flow: Flow,
  options: ResolveVariablesOptions<R>
): Effect.Effect<PreflightReport, PreflightFailed, R | FileSystem.FileSystem> =>
  Effect.gen(function* runPreflight() {
    const fileSystem = yield* FileSystem.FileSystem;
    const supplied = new Map<string, string>();
    const problems: string[] = [];
    const warnings: string[] = [];

    for (const entry of options.secrets) {
      const parsed = parseSecretFlag(entry);
      if (parsed === undefined) {
        problems.push(`--secret ${entry} is not NAME=value or NAME.`);
        continue;
      }
      if (parsed.value !== undefined) {
        supplied.set(parsed.name, parsed.value);
        continue;
      }
      const fromEnvironment =
        options.environment[variableEnvironmentName(parsed.name)];
      if (fromEnvironment === undefined) {
        problems.push(
          `--secret ${parsed.name} reads ${variableEnvironmentName(parsed.name)}, which is not set.`
        );
        continue;
      }
      supplied.set(parsed.name, fromEnvironment);
    }

    const declared = declaredVariables(flow);
    const declaredNames = new Set(declared.map(({ name }) => name));
    for (const name of supplied.keys()) {
      if (!declaredNames.has(name)) {
        warnings.push(
          `--secret ${name} was supplied, but this Flow declares no Variable named ${name}.`
        );
      }
    }

    const values = new Map<string, string>();
    const secretNames = new Set<string>();

    for (const variable of declared) {
      if (variable.secret) {
        secretNames.add(variable.name);
      }

      const value = supplied.get(variable.name);
      if (value !== undefined) {
        values.set(variable.name, value);
        continue;
      }

      if (!variable.runtime) {
        problems.push(
          `Variable ${variable.name} has no value. Supply it with --secret ${variable.name}=value, or --secret ${variable.name} to read ${variableEnvironmentName(variable.name)}.`
        );
        continue;
      }

      if (!options.interactive) {
        // Never prompt without a terminal: an unattended job would hang forever
        // rather than fail in seconds.
        problems.push(
          `Variable ${variable.name} has no value and there is no interactive terminal to prompt. Supply it with --secret ${variable.name}=value, or --secret ${variable.name} to read ${variableEnvironmentName(variable.name)}.`
        );
        continue;
      }

      const answered = yield* options.prompt(variable);
      const revealed = Redacted.value(answered);
      if (revealed.length === 0) {
        problems.push(`Variable ${variable.name} was left empty.`);
        continue;
      }
      values.set(variable.name, revealed);
    }

    // An unwritable output path is worth knowing before a browser opens, not
    // after a Run has executed and has nowhere to go.
    //
    // Neither creating the directory nor probing its mode settles this. A
    // recursive create succeeds on an existing directory whatever its
    // permissions, and a POSIX directory that is writable but not searchable
    // passes a write-access check while still refusing to hold a new file.
    // Creating and removing a real file is the only check that answers the
    // question actually being asked, and it also covers read-only mounts,
    // ACLs, and quota.
    const probePath = `${options.outputDirectory}/.contingency-preflight-${randomUUID()}`;
    const outputOutcome = yield* Effect.exit(
      fileSystem
        .makeDirectory(options.outputDirectory, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFileString(probePath, "")),
          Effect.ensuring(fileSystem.remove(probePath).pipe(Effect.ignore))
        )
    );
    if (Exit.isFailure(outputOutcome)) {
      problems.push(
        `Output directory ${options.outputDirectory} cannot be created or written: ${Cause.squash(outputOutcome.cause)}`
      );
    }

    if (options.retriesEnabled) {
      for (const variable of declared) {
        if (variable.secret && variable.runtime) {
          // A single-use code cannot survive a retry: re-prompting hangs an
          // unattended Run, and reusing the value fails authentication.
          warnings.push(
            `Variable ${variable.name} is both secret and runtime, which usually means a single-use code. A retry cannot reuse it — consider --retry 0.`
          );
        }
      }
    }

    if (problems.length > 0) {
      return yield* new PreflightFailed({ problems });
    }

    return {
      resolution: { secretNames, values },
      warnings,
    } satisfies PreflightReport;
  });

const REFERENCE_PATTERN = /\{\{(?<name>[A-Z][A-Z0-9_]*)\}\}/gu;

/**
 * Replace `{{NAME}}` references with resolved values. Applied to a Step as it
 * executes, never to the Flow embedded in the Run, so the persisted artifact
 * keeps the reference rather than the value.
 */
export const substituteVariables = (
  value: string,
  values: ReadonlyMap<string, string>
): string =>
  value.replaceAll(REFERENCE_PATTERN, (match, ...rest) => {
    const groups = rest.at(-1) as { readonly name?: string } | undefined;
    const name = groups?.name;
    if (name === undefined) {
      return match;
    }
    return values.get(name) ?? match;
  });

/**
 * Names referenced by a Flow but never declared. These are left as literal
 * `{{NAME}}` text rather than silently becoming an empty string, so a typo in a
 * Flow is visible rather than submitted to a form.
 */
export const undeclaredReferences = (
  flow: Flow,
  declaredNames: ReadonlySet<string>
): readonly string[] => {
  const referenced = new Set<string>();
  for (const match of JSON.stringify(flow).matchAll(REFERENCE_PATTERN)) {
    const name = match.groups?.name;
    if (name !== undefined && !declaredNames.has(name)) {
      referenced.add(name);
    }
  }
  return [...referenced];
};

/**
 * Remove every secret value from text bound for the Run. Step errors quote the
 * browser's message, which can echo a value that was typed into a field.
 */
export const redactSecrets = (
  value: string,
  resolution: VariableResolution
): string => {
  // Longest first. Replacing a shorter value that is a prefix of a longer one
  // would rewrite part of the longer value and leave the rest in place —
  // `SHORT=abc` before `LONG=abc123456` yields `{{SHORT}}123456`, persisting
  // the sensitive tail.
  const secretValues = [...resolution.values]
    .filter(
      ([name, secret]) => resolution.secretNames.has(name) && secret !== ""
    )
    .toSorted(([, left], [, right]) => right.length - left.length);

  let redacted = value;
  for (const [name, secretValue] of secretValues) {
    redacted = redacted.replaceAll(secretValue, `{{${name}}}`);
  }
  return redacted;
};
