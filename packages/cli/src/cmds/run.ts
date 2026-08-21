import path from "node:path";

import { Console, Data, Effect, FileSystem, Option, Runtime } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { AgentBrowser } from "../services/agent-browser";
import { decodeFlowDocument, Runner, RunnerError } from "../services/runner";
import { defaultRunsDirectory } from "../services/state-directory";

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
  },
  Effect.fnUntraced(function* runFlow({ flowPath, output }) {
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

    yield* agentBrowser.init().pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: `Could not prepare the browser: ${cause.message}`,
          })
      )
    );

    const outputDirectory = Option.isSome(output)
      ? path.resolve(output.value)
      : defaultRunsDirectory();
    const { directory, run } = yield* runner.run(flow, { outputDirectory });

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
