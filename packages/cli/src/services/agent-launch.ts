import path from "node:path";

import { Effect, Option } from "effect";

import { AgentHarnesses, allHarnesses } from "./agent-harness.ts";
import type {
  AgentHarness,
  HarnessId,
  HarnessReadiness,
} from "./agent-harness.ts";
import { AgentLaunchError } from "./agent-launch-error.ts";
import type { ServerSpec } from "./agent-registration.ts";
import { SERVER_NAME } from "./agent-registration.ts";
import { CATALOG_DIRECTORY } from "./flow-skill-catalog.ts";
import { STARTER_PROMPT_URI, WORK_PROMPT_URI } from "./mcp-onboarding.ts";

/**
 * Launching an installed Agent Harness with Contingency connected for one
 * session (`contingency start`).
 *
 * `--demo` runs onboarding on the bundled demo store. Without it the agent
 * follows the work prompt on the user's own website, and the server leaves
 * the demo store and its Example tools out.
 *
 * Each harness supplies the MCP server through its own session-only launch
 * plan, which writes no configuration and touches no authentication, model,
 * or permission settings. The agent spawns Contingency as a stdio child that
 * owns its own browser and Workspace on an available port.
 */

/** A harness whose executable is on PATH at a supported version. */
export interface ReadyHarness {
  readonly executable: string;
  readonly harness: AgentHarness;
  readonly version: string;
}

const either = new Intl.ListFormat("en", { type: "disjunction" });
const both = new Intl.ListFormat("en", { type: "conjunction" });

const unavailable = (
  harness: AgentHarness,
  readiness: Exclude<HarnessReadiness, { readonly _tag: "ready" }>
): string =>
  readiness._tag === "not-installed"
    ? `${harness.label} is not installed or not on PATH. ${harness.install}`
    : `${harness.label} at ${readiness.executable} ${readiness.reported === undefined ? "did not report a version" : `reports ${JSON.stringify(readiness.reported)}`}, which this release does not support. ${harness.install}`;

const missingHarnessesMessage = (harnesses: readonly AgentHarness[]): string =>
  [
    `Contingency onboarding needs ${either.format(harnesses.map((harness) => harness.label))}.`,
    ...harnesses.map((harness) => `- ${harness.label}: ${harness.install}`),
    "Then run `npx @contingencyhq/cli start` again.",
  ].join("\n");

/**
 * Choose the harness: the explicit `--agent`, the one ready harness, or the
 * user's pick among several. A harness that is missing or at an unsupported
 * version is reported with the step that fixes it. Without `pick`, as in a
 * non-interactive terminal, several ready harnesses are an error naming each
 * `--agent` value.
 */
export const chooseHarness = <R>(input: {
  readonly pathVariable: string | undefined;
  readonly pick: Option.Option<
    (
      ready: readonly ReadyHarness[]
    ) => Effect.Effect<ReadyHarness, AgentLaunchError, R>
  >;
  readonly requested: Option.Option<HarnessId>;
}) =>
  Effect.gen(function* choose() {
    const harnesses = yield* AgentHarnesses;
    const check = (harness: AgentHarness) =>
      harness
        .readiness(input.pathVariable)
        .pipe(Effect.map((readiness) => ({ harness, readiness })));
    if (Option.isSome(input.requested)) {
      const { harness, readiness } = yield* check(
        harnesses[input.requested.value]
      );
      if (readiness._tag !== "ready") {
        return yield* Effect.fail(
          new AgentLaunchError({ message: unavailable(harness, readiness) })
        );
      }
      return {
        executable: readiness.executable,
        harness,
        version: readiness.version,
      } satisfies ReadyHarness;
    }
    const checked = yield* Effect.forEach(allHarnesses(harnesses), check, {
      concurrency: "unbounded",
    });
    const ready = checked.flatMap(({ harness, readiness }) =>
      readiness._tag === "ready"
        ? [
            {
              executable: readiness.executable,
              harness,
              version: readiness.version,
            } satisfies ReadyHarness,
          ]
        : []
    );
    const [first, second] = ready;
    if (first === undefined) {
      const installed = checked.flatMap(({ harness, readiness }) =>
        readiness._tag === "not-installed" || readiness._tag === "ready"
          ? []
          : [unavailable(harness, readiness)]
      );
      return yield* Effect.fail(
        new AgentLaunchError({
          message:
            installed.length === 0
              ? missingHarnessesMessage(allHarnesses(harnesses))
              : installed.join("\n"),
        })
      );
    }
    if (second === undefined) {
      return first;
    }
    if (Option.isNone(input.pick)) {
      return yield* Effect.fail(
        new AgentLaunchError({
          message: `${both.format(ready.map((entry) => entry.harness.label))} are installed. Choose one with ${either.format(ready.map((entry) => `--agent ${entry.harness.id}`))}.`,
        })
      );
    }
    return yield* input.pick.value(ready);
  });

/** How to start this same CLI again from an agent or a registration. */
export interface CliInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

/**
 * Start the installed CLI directly. Session children must never resolve a
 * new npm spec while the agent waits for its MCP handshake.
 */
export const currentInvocation = (input: {
  readonly execPath: string;
  readonly script: string;
}): CliInvocation => ({
  args: [path.resolve(input.script)],
  command: input.execPath,
});

// vpx uses pnpm's dlx cache. Yarn can expose either its temporary project
// or a PnP zip path, and its cache folder can have any name. Only a package
// cache serves code from inside a zip. Match runner directories, not
// ordinary global installs.
const isRunnerCache = (script: string): boolean => {
  const normalized = script.replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:_npx\/|dlx\/[^/]+\/(?:[^/]+\/)?node_modules\/|bunx-[^/]+\/|dlx-[^/]+\/)/u.test(
      normalized
    ) || /\.zip\/node_modules\//u.test(normalized)
  );
};

/** A cache path is unsuitable for permanent registration or later reconnects. */
export const persistentInvocation = (input: {
  readonly execPath: string;
  readonly packageName: string;
  readonly script: string;
  readonly version: string;
}): CliInvocation =>
  isRunnerCache(input.script)
    ? {
        args: ["-y", `${input.packageName}@${input.version}`],
        command: "npx",
      }
    : { args: [path.resolve(input.script)], command: input.execPath };

/** The session-only server: this directory's catalog and an available port. */
export const sessionServerSpec = (input: {
  readonly agent: HarnessId;
  readonly demo: boolean;
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
    "--session-only",
    ...(input.demo ? ["--demo"] : []),
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

/** The command that starts this session-only connection again. */
export const reconnectCommand = (input: {
  readonly agent: HarnessId;
  readonly invocation: CliInvocation;
}): string =>
  [
    input.invocation.command,
    ...input.invocation.args,
    "start",
    "--agent",
    input.agent,
  ]
    .map(shellQuote)
    .join(" ");

export const registrationCommand = (input: {
  readonly agent: HarnessId;
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

/** The server resource owns the procedure and this process's launch context. */
export const demoInitialMessage = (): string =>
  `Read the MCP resource ${STARTER_PROMPT_URI} from the ${SERVER_NAME} server and follow it.`;

export const workInitialMessage = (): string =>
  `Read the MCP resource ${WORK_PROMPT_URI} from the ${SERVER_NAME} server and follow it.`;
