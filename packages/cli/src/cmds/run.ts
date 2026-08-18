import path from "node:path";

import {
  Console,
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Runtime,
} from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { AgentBrowser } from "../services/agent-browser";
import {
  decodeFlowDocument,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  flowRunsDirectory,
  Runner,
  RunnerError,
} from "../services/runner";
import { defaultRunsDirectory } from "../services/state-directory";
import { preflight } from "../services/variables";

/**
 * A Run that did not complete is the product's core signal, not a crash. It
 * exits 1 and prints its own message, rather than being reported to the
 * terminal as an unhandled failure with a stack trace (ADR 0009).
 */
class RunDidNotComplete extends Data.TaggedError("RunDidNotComplete")<{
  readonly message: string;
}> {
  readonly [Runtime.errorReported] = false;
  readonly [Runtime.errorExitCode] = 1;
}

export const runCommand = Command.make(
  "run",
  {
    flowPath: Argument.file("flow", { mustExist: true }),
    output: Flag.string("output").pipe(
      Flag.withDescription(
        "Directory to write Runs into. Defaults to the Contingency state directory."
      ),
      Flag.optional
    ),
    retry: Flag.integer("retry").pipe(
      Flag.withDescription(
        "Extra attempts a failing Flow gets, each in a fresh browser session. 0 disables retrying, which a Flow with real side effects needs."
      ),
      Flag.withDefault(DEFAULT_RETRY)
    ),
    secret: Flag.string("secret").pipe(
      Flag.withDescription(
        "Supply a Variable as NAME=value, or as NAME to read it from CONTINGENCY_SECRET_NAME. Repeatable."
      ),
      Flag.atLeast(0)
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDescription(
        "Wall-clock ceiling for the whole Run in seconds, retries included."
      ),
      Flag.withDefault(Duration.toSeconds(DEFAULT_TIMEOUT))
    ),
  },
  Effect.fnUntraced(function* runFlow({
    flowPath,
    output,
    retry,
    secret,
    timeout,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* Runner;
    const agentBrowser = yield* AgentBrowser;
    const resolvedPath = path.resolve(flowPath);

    const contents = yield* fileSystem.readFileString(resolvedPath).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: `Could not read ${resolvedPath}: ${cause.message}`,
          })
      )
    );
    const flow = yield* decodeFlowDocument(contents, resolvedPath);

    const outputDirectory = Option.isSome(output)
      ? path.resolve(output.value)
      : defaultRunsDirectory();

    // Preflight before the browser opens, so a misconfigured invocation fails
    // in seconds with every problem listed rather than eight Steps deep.
    const { resolution, warnings } = yield* preflight(flow, {
      environment: process.env,
      interactive: process.stdin.isTTY === true,
      // Probe the directory this Flow's Runs are actually filed in, not just
      // the output root, which may be writable while that one is not.
      outputDirectory: flowRunsDirectory(outputDirectory, flow),
      prompt: (variable) =>
        Prompt.run(
          Prompt.password({
            message: `Value for Variable ${variable.name}`,
          })
        ).pipe(Effect.orDie),
      retriesEnabled: retry > 0,
      secrets: secret,
    }).pipe(Effect.tapError((failure) => Console.error(failure.message)));

    for (const warning of warnings) {
      yield* Console.warn(`Warning: ${warning}`);
    }

    yield* agentBrowser.init().pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: `Could not prepare the browser: ${cause.message}`,
          })
      )
    );

    const { directory, run } = yield* runner.run(flow, {
      outputDirectory,
      retry,
      timeout: Duration.seconds(timeout),
      variables: resolution,
    });

    if (run.attempts.length > 1) {
      // Silent retry is how a Flow that fails 40% of the time reports green for
      // a month, so a Run that needed more than one attempt says so.
      yield* Console.warn(
        `Warning: this Run needed ${run.attempts.length} attempts.`
      );
    }

    const findings = run.steps.reduce(
      (total, step) => total + (step.findings?.length ?? 0),
      0
    );
    // The engine lists at most a fixed number of elements per rule while
    // counting them all, so the Findings can be fewer than the page has.
    const elided = run.steps.reduce(
      (total, step) =>
        total +
        (step.elidedFindings ?? []).reduce(
          (missing, rule) => missing + (rule.total - rule.reported),
          0
        ),
      0
    );
    if (findings > 0) {
      // Reported, never fatal: every real site has pre-existing violations, so
      // failing on their count makes the check red on day one (ADR 0009).
      yield* Console.log(
        `${findings} accessibility ${findings === 1 ? "Finding" : "Findings"}${
          elided === 0
            ? ""
            : `, and ${elided} more the accessibility engine counted but did not list`
        }.`
      );
    }

    yield* Console.log(`Run ${run.runId} ${run.outcome}`);
    yield* Console.log(directory);

    if (run.outcome === "completed") {
      return;
    }

    yield* Console.error(
      run.failure === undefined
        ? "The Run did not complete."
        : `The Run did not complete: ${run.failure.message}`
    );

    // Exit 1 when the Run did not complete. Findings never influence the exit
    // code — that is what Regressions are for (ADR 0009).
    return yield* new RunDidNotComplete({
      message: "The Run did not complete.",
    });
  })
).pipe(Command.withDescription("Execute a Flow into a Run, headlessly."));
