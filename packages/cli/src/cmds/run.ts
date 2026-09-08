import path from "node:path";

import { runExitCode } from "@contingency/protocol";
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

import { flowBrowserIdentityWarnings } from "../services/browser-identity.ts";
import {
  decodeFlowDocument,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  flowRunsDirectory,
  Runner,
  RunnerError,
} from "../services/runner.ts";
import { defaultRunsDirectory } from "../services/state-directory.ts";
import { preflight } from "../services/variables.ts";
import {
  findingsSummary,
  gateOverride,
  gateOverrideWarning,
  unmeasuredWarning,
  videoWarning,
} from "./run-report.ts";

/**
 * How a finished Run leaves the process. Outcome and exit code are separate
 * axes ([ADR 0018](../../../../docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)):
 * `1` means the Run did not complete, `2` means it completed and breached its
 * Gate. Either way this is the product's core signal rather than a crash, so
 * it prints its own message instead of surfacing as an unhandled failure.
 */
class RunExit extends Data.TaggedError("RunExit")<{
  readonly code: 1 | 2;
  readonly message: string;
}> {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

export const runCommand = Command.make(
  "run",
  {
    flowPath: Argument.file("flow", { mustExist: true }),
    gate: Flag.string("gate").pipe(
      Flag.withDescription(
        "An accessibility rule id that must produce no Finding, e.g. image-alt. Repeatable, and replaces the Flow's own Gate. A breach exits 2 without failing the Run."
      ),
      Flag.atLeast(0)
    ),
    ignoreGate: Flag.boolean("ignore-gate").pipe(
      Flag.withDescription(
        "Hold this Run to no Gate, whatever the Flow declares."
      ),
      Flag.withDefault(false)
    ),
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
    trace: Flag.boolean("trace").pipe(
      Flag.withDescription(
        "Keep a Playwright Trace for each attempt. On by default; Traces are sensitive and best-effort scrubbing is not complete."
      ),
      Flag.optional
    ),
    video: Flag.boolean("video").pipe(
      Flag.withDescription(
        "Generate a WebM from each attempt's per-Step Trace screenshots. Off by default; videos are sensitive."
      ),
      Flag.optional
    ),
  },
  Effect.fnUntraced(function* runFlow({
    flowPath,
    gate,
    ignoreGate,
    output,
    retry,
    secret,
    timeout,
    trace,
    video,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* Runner;
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
    const { resolution, warnings: preflightWarnings } = yield* preflight(flow, {
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

    const warnings = [
      ...flowBrowserIdentityWarnings(flow.emulation),
      ...preflightWarnings,
    ];
    for (const warning of warnings) {
      yield* Console.warn(`Warning: ${warning}`);
    }

    // Video is an observation aid, never a Flow property: it reflects how
    // this Run was invoked (ADR 0014).
    const keepTrace = Option.isSome(trace) ? trace.value : true;
    const makeVideo = Option.isSome(video) ? video.value : false;
    if (
      (keepTrace || makeVideo) &&
      (flow.variables ?? []).some((variable) => variable.secret)
    ) {
      yield* Console.warn(
        "Warning: this Flow declares secret Variables and artifacts are on. Traces and derived videos are sensitive; Trace scrubbing is only best effort."
      );
    }

    const conflicting = gateOverrideWarning(gate, ignoreGate);
    if (conflicting !== undefined) {
      yield* Console.warn(conflicting);
    }
    const rules = gateOverride(gate, ignoreGate);

    const runOptions = {
      outputDirectory,
      retry,
      timeout: Duration.seconds(timeout),
      trace: keepTrace,
      variables: resolution,
      video: makeVideo,
    };
    const { directory, run } = yield* runner.run(
      flow,
      rules === undefined ? runOptions : { ...runOptions, gate: rules }
    );

    if (run.attempts.length > 1) {
      // Silent retry is how a Flow that fails 40% of the time reports green for
      // a month, so a Run that needed more than one attempt says so.
      yield* Console.warn(
        `Warning: this Run needed ${run.attempts.length} attempts.`
      );
    }

    const summary = findingsSummary(run);
    if (summary !== undefined) {
      yield* Console.log(summary);
    }

    const unmeasured = unmeasuredWarning(run);
    if (unmeasured !== undefined) {
      yield* Console.warn(unmeasured);
    }

    const unrecorded = yield* videoWarning(run, directory);
    if (unrecorded !== undefined) {
      yield* Console.warn(unrecorded);
    }

    yield* Console.log(`Run ${run.runId} ${run.outcome}`);
    yield* Console.log(directory);

    // The protocol owns which code a Run earns, so the CLI reports one of the
    // three rather than re-deriving the rule (ADR 0018).
    switch (runExitCode(run)) {
      case 0: {
        return;
      }
      case 1: {
        yield* Console.error(
          run.failure === undefined
            ? "The Run did not complete."
            : `The Run did not complete: ${run.failure.message}`
        );
        return yield* new RunExit({
          code: 1,
          message: "The Run did not complete.",
        });
      }
      default: {
        const breach = `The Run completed and breached its Gate: ${(run.gate?.breached ?? []).join(", ")}.`;
        // Said as plainly as the outcome line above it: the Run is fine and
        // still a Baseline; the site missed a bar its author chose.
        yield* Console.error(breach);
        return yield* new RunExit({ code: 2, message: breach });
      }
    }
  })
).pipe(Command.withDescription("Execute a Flow into a Run, headlessly."));
