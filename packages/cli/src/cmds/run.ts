import path from "node:path";

import { Console, Data, Effect, FileSystem, Option, Runtime } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { AgentBrowser } from "../services/agent-browser";
import { decodeFlowDocument, Runner, RunnerError } from "../services/runner";
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
    secret: Flag.string("secret").pipe(
      Flag.withDescription(
        "Supply a Variable as NAME=value, or as NAME to read it from CONTINGENCY_SECRET_NAME. Repeatable."
      ),
      Flag.atLeast(0)
    ),
  },
  Effect.fnUntraced(function* runFlow({ flowPath, output, secret }) {
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
      outputDirectory,
      prompt: (variable) =>
        Prompt.run(
          Prompt.password({
            message: `Value for Variable ${variable.name}`,
          })
        ).pipe(Effect.orDie),
      // `--retry` arrives with retry itself; the documented default is 3.
      retriesEnabled: true,
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
      variables: resolution,
    });

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
