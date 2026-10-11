import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { Context, Effect, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type {
  RegistrationError,
  RegistrationOutcome,
  RegistrationRequest,
  ServerSpec,
} from "./agent-registration.ts";

/**
 * The Agent Harness contract: everything Contingency does differently for
 * each coding agent CLI it launches, registers with, or is spawned by.
 *
 * Commands look a harness up by id through the {@link AgentHarnesses}
 * service and never branch on the id themselves. Adding a harness means a new
 * id in {@link HARNESS_IDS}, one harness module with its own Layer, and one
 * entry in the `AgentHarnesses` Layer; the `Record<HarnessId, AgentHarness>`
 * type rejects an id without an implementation.
 */

export const HARNESS_IDS = ["claude", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * Whether a harness can be launched. Readiness comes only from the
 * executable on PATH and its `--version` output: it never probes
 * authentication and never sends a model prompt, so a signed-out harness
 * launches and shows its own sign-in.
 */
export type HarnessReadiness =
  | { readonly _tag: "not-installed" }
  | {
      readonly _tag: "ready";
      readonly executable: string;
      readonly version: string;
    }
  | {
      readonly _tag: "unsupported";
      readonly executable: string;
      /** The first line `--version` printed, when it printed anything. */
      readonly reported: string | undefined;
    };

/**
 * How to start a harness for one session. It never writes files and never
 * edits persistent harness configuration; `env` is added to the inherited
 * environment.
 */
export interface LaunchPlan {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface LaunchRequest {
  readonly executable: string;
  /** Arguments the user passed after `--`. */
  readonly extra: readonly string[];
  readonly message: string;
  readonly spec: ServerSpec;
}

export interface AgentHarness {
  readonly id: HarnessId;
  /** How to install a supported version. */
  readonly install: string;
  readonly label: string;
  /** The newest version this release was verified with. */
  readonly verifiedVersion: string;
  readonly readiness: (
    pathVariable: string | undefined
  ) => Effect.Effect<HarnessReadiness>;
  readonly launchPlan: (request: LaunchRequest) => Effect.Effect<LaunchPlan>;
  /** The server a permanent registration of this harness starts. */
  readonly registrationServerSpec: (input: {
    readonly fallbackDirectory: string;
    readonly invocation: {
      readonly args: readonly string[];
      readonly command: string;
    };
  }) => ServerSpec;
  readonly register: (
    request: RegistrationRequest
  ) => Effect.Effect<RegistrationOutcome, RegistrationError>;
  /**
   * The project directory this harness reports to the stdio servers it
   * spawns, before Catalog Root usability checks.
   */
  readonly currentProjectDirectory: (input: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) => Effect.Effect<string>;
}

export class AgentHarnesses extends Context.Service<
  AgentHarnesses,
  Readonly<Record<HarnessId, AgentHarness>>
>()("@contingency/AgentHarnesses") {}

/** Every harness, in {@link HARNESS_IDS} order. */
export const allHarnesses = (
  harnesses: Readonly<Record<HarnessId, AgentHarness>>
): AgentHarness[] => HARNESS_IDS.map((id) => harnesses[id]);

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

const versionOutput = (executable: string) =>
  Effect.gen(function* readVersion() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .string(
        ChildProcess.make(executable, ["--version"], {
          extendEnv: true,
          stdin: "ignore",
        })
      )
      .pipe(Effect.timeout("20 seconds"), Effect.option);
  });

const VERSION = /\d+\.\d+\.\d+/u;

/**
 * The version in `--version` output when it names `product` at a supported
 * major version, or none.
 */
export const supportedVersion = (
  output: string,
  supported: { readonly major: number; readonly product: RegExp }
): Option.Option<string> => {
  if (!supported.product.test(output)) {
    return Option.none();
  }
  const version = VERSION.exec(output)?.[0];
  return version !== undefined &&
    Number(version.split(".")[0]) === supported.major
    ? Option.some(version)
    : Option.none();
};

/** Readiness from the executable on PATH and its `--version` output. */
export const versionReadiness = (input: {
  readonly binary: string;
  readonly major: number;
  readonly pathVariable: string | undefined;
  readonly product: RegExp;
}) =>
  Effect.gen(function* probeReadiness() {
    const executable = yield* findOnPath(input.binary, input.pathVariable);
    if (Option.isNone(executable)) {
      return { _tag: "not-installed" } satisfies HarnessReadiness;
    }
    const output = (yield* versionOutput(executable.value)).pipe(
      Option.map((text) => text.trim())
    );
    const version = output.pipe(
      Option.flatMap((text) => supportedVersion(text, input))
    );
    if (Option.isNone(version)) {
      const reported = Option.getOrUndefined(output)?.split("\n")[0];
      return {
        _tag: "unsupported",
        executable: executable.value,
        reported:
          reported === undefined || reported.length === 0
            ? undefined
            : reported,
      } satisfies HarnessReadiness;
    }
    return {
      _tag: "ready",
      executable: executable.value,
      version: version.value,
    } satisfies HarnessReadiness;
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
