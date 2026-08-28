import path from "node:path";

import {
  makeBrowserRpcError,
  runIsInFlight,
  RunTraceManifest as RunTraceManifestSchema,
  RunVideoManifest as RunVideoManifestSchema,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  Flow,
  Run,
  RunSnapshot,
  RunStep,
  RunTraceManifest,
  RunVariablePrompt,
  RunVideoManifest,
} from "@contingency/protocol";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  PubSub,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";

import {
  DEFAULT_RETRY,
  decodeFlowDocument,
  flowRunsDirectory,
  Runner,
} from "./runner.ts";
import type { RunProgress, RunnerService } from "./runner.ts";
import { preflight } from "./variables.ts";
import type { VariableResolution } from "./variables.ts";

/**
 * The one Flow `contingency web` was opened on, and where its Runs are filed.
 * Absent when the process was started without a Flow argument, which is the
 * ordinary Create View invocation: Audit View then has nothing to audit and
 * says so, rather than offering a Flow picker that does not exist (ADR 0023).
 */
export interface RunSessionInput {
  readonly flow: Flow | null;
  readonly outputDirectory: string;
}

/**
 * Audit View's whole surface onto the Runner. A viewer over one Run of one
 * Flow: it starts a Run, streams what the Run reports, answers the Runner's
 * one blocking question, and resolves the paths of the artifacts a finished
 * Run produced.
 */
export interface RunSessionService {
  /**
   * Absolute path of one artifact file belonging to the finished Run, or a
   * failure when there is no such Run, the id does not match, or the manifests
   * do not name that file. Resolving through the manifests rather than through
   * the request means a caller cannot name a path of its own: an unredacted
   * Trace lives in that directory.
   */
  readonly artifactPath: (
    runId: string,
    attempt: number,
    kind: "video"
  ) => Effect.Effect<string, BrowserRpcErrorType>;
  readonly answerVariable: (
    name: string,
    value: string
  ) => Effect.Effect<RunSnapshot, BrowserRpcErrorType>;
  readonly changes: () => Stream.Stream<RunSnapshot>;
  /**
   * Replace the loaded Flow with one the browser handed over. The document
   * travels in the request rather than as a path, so this reads nothing from
   * the filesystem and cannot be pointed at a file of the caller's choosing.
   */
  readonly loadFlow: (
    document: string,
    source: string
  ) => Effect.Effect<RunSnapshot, BrowserRpcErrorType>;
  readonly get: () => Effect.Effect<RunSnapshot | null>;
  readonly start: () => Effect.Effect<RunSnapshot, BrowserRpcErrorType>;
}

export const RunSession = Context.Service<RunSessionService>(
  "@contingency/RunSession"
);

/** How many attempts a Run started from Audit View may make. */
export const attemptCeiling = (retry: number): number => retry + 1;

/** The question the Runner is blocked on, and where its answer goes. */
interface PendingPrompt {
  readonly awaiting: Deferred.Deferred<string>;
  readonly name: string;
}

interface RunSessionState extends RunSnapshot {
  /** Where the finished Run was written. Never leaves the process. */
  readonly directory: string | undefined;
}

const toSnapshot = ({
  directory: _,
  ...snapshot
}: RunSessionState): RunSnapshot => snapshot;

const idleState = (flow: Flow): RunSessionState => ({
  attemptCeiling: attemptCeiling(DEFAULT_RETRY),
  directory: undefined,
  flow,
  phase: "idle",
  run: null,
  steps: [],
  trace: null,
  variablePrompt: null,
  video: null,
  warnings: [],
});

/**
 * Read a manifest the Runner wrote beside the Run. A manifest that is missing
 * or unreadable is reported as absent rather than as a failure: artifacts are
 * an observation aid, and a Run that executed is still a Run (ADR 0014).
 */
const readManifest = <A>(
  fileSystem: FileSystem.FileSystem,
  file: string,
  schema: Schema.Codec<A, unknown>
): Effect.Effect<A | null> =>
  fileSystem.readFileString(file).pipe(
    Effect.flatMap((contents) =>
      Effect.try(() => JSON.parse(contents) as unknown)
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.catchCause(() => Effect.succeed(null))
  );

export const makeRunSessionService = ({
  flow,
  outputDirectory,
}: RunSessionInput): Effect.Effect<
  RunSessionService,
  never,
  FileSystem.FileSystem | RunnerService
> =>
  Effect.gen(function* makeRunSession() {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* Runner;
    const stateRef = yield* Ref.make<RunSessionState | null>(
      flow === null ? null : idleState(flow)
    );
    const updates = yield* PubSub.sliding<RunSnapshot>(64);
    /**
     * The question the Runner is blocked on, and where its answer goes. One at
     * a time: preflight resolves Variables in order and waits for each.
     */
    const pendingRef = yield* Ref.make<PendingPrompt | null>(null);

    const update = (
      change: (state: RunSessionState) => RunSessionState
    ): Effect.Effect<RunSnapshot | null> =>
      Ref.updateAndGet(stateRef, (state) =>
        state === null ? null : change(state)
      ).pipe(
        Effect.tap((state) =>
          state === null
            ? Effect.void
            : PubSub.publish(updates, toSnapshot(state))
        ),
        Effect.map((state) => (state === null ? null : toSnapshot(state)))
      );

    const requireFlow = Effect.fn("RunSession.requireFlow")(
      function* requireFlow() {
        const state = yield* Ref.get(stateRef);
        if (state === null) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "run_unavailable",
              "This server was started without a Flow. Run `contingency web <flow>` to audit one."
            )
          );
        }
        return state;
      }
    );

    /**
     * The Runner's prompt seam, answered by the browser. A web server is never
     * an interactive terminal, so without this a Flow declaring a `runtime`
     * Variable — the 2FA case the Variable model was designed around — would
     * fail before its first Step (ADR 0023).
     */
    const promptInBrowser = (variable: {
      readonly name: string;
      readonly secret: boolean;
    }) =>
      Effect.gen(function* promptForVariable() {
        const awaiting = yield* Deferred.make<string>();
        yield* Ref.set(pendingRef, { awaiting, name: variable.name });
        const prompt: RunVariablePrompt = {
          name: variable.name,
          secret: variable.secret,
        };
        yield* update((state) => ({ ...state, variablePrompt: prompt }));
        // Cleared by whoever answers, so the answer's own reply already shows
        // the Run unblocked rather than echoing the question back.
        const value = yield* Deferred.await(awaiting);
        return Redacted.make(value);
      });

    const progress: RunProgress = {
      emit: (event) =>
        update((state) => {
          switch (event._tag) {
            case "attemptStarted": {
              // Attempts are never concatenated into one timeline: a fresh
              // context is a fresh Run of the Flow (ADR 0015).
              return {
                ...state,
                attempt: event.attempt,
                phase: "running",
                runningIndex: undefined,
                steps: [],
              };
            }
            case "stepStarted": {
              return { ...state, phase: "running", runningIndex: event.index };
            }
            default: {
              return {
                ...state,
                phase: "running",
                runningIndex: undefined,
                steps: [...state.steps, event.step],
              };
            }
          }
        }).pipe(Effect.asVoid),
    };

    const finish = Effect.fn("RunSession.finish")(function* finish(
      directory: string,
      run: Run
    ) {
      const video = yield* readManifest<RunVideoManifest>(
        fileSystem,
        path.join(directory, "video.json"),
        RunVideoManifestSchema
      );
      const trace = yield* readManifest<RunTraceManifest>(
        fileSystem,
        path.join(directory, "trace.json"),
        RunTraceManifestSchema
      );
      yield* update((state) => ({
        ...state,
        attempt: run.attempts.at(-1)?.attempt,
        directory,
        // A Gate breach is a verdict on the site, never on the Run, so the
        // outcome the interface reads is the Run's own (ADR 0018).
        outcome: run.outcome,
        phase: "finished",
        run,
        runningIndex: undefined,
        steps: run.steps as RunStep[],
        trace,
        video,
      }));
    });

    const execute = Effect.fn("RunSession.execute")(function* execute(
      started: Flow
    ) {
      const report = yield* Effect.result(
        preflight(started, {
          environment: process.env,
          // The browser is the terminal here, and it is always there.
          interactive: true,
          outputDirectory: flowRunsDirectory(outputDirectory, started),
          prompt: promptInBrowser,
          retriesEnabled: DEFAULT_RETRY > 0,
          // Audit View supplies no `--secret` flags; every Variable is
          // resolved from the environment or asked for in the browser.
          secrets: [],
        })
      );
      if (report._tag === "Failure") {
        yield* update((state) => ({
          ...state,
          error: report.failure.message,
          phase: "idle",
          variablePrompt: null,
        }));
        return;
      }
      const { resolution, warnings } = report.success;
      yield* update((state) => ({ ...state, warnings: [...warnings] }));

      const outcome = yield* Effect.result(
        runner.run(started, {
          onProgress: progress,
          outputDirectory,
          retry: DEFAULT_RETRY,
          // A Run started from Audit View cannot disable either artifact:
          // stepping the timeline is stepping the frames video derivation
          // captures (ADR 0023).
          trace: true,
          variables: resolution satisfies VariableResolution,
          video: true,
        })
      );
      if (outcome._tag === "Failure") {
        yield* update((state) => ({
          ...state,
          error: outcome.failure.message,
          phase: "idle",
          runningIndex: undefined,
          variablePrompt: null,
        }));
        return;
      }
      yield* finish(outcome.success.directory, outcome.success.run);
    });

    const service: RunSessionService = {
      answerVariable: (name, value) =>
        Effect.gen(function* answerVariable() {
          yield* requireFlow();
          const pending = yield* Ref.get(pendingRef);
          if (pending === null || pending.name !== name) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "run_invalid",
                `No Run is waiting for Variable ${name}.`
              )
            );
          }
          yield* Ref.set(pendingRef, null);
          yield* update((current) => ({ ...current, variablePrompt: null }));
          yield* Deferred.succeed(pending.awaiting, value);
          return toSnapshot(yield* requireFlow());
        }),

      artifactPath: (runId, attempt, kind) =>
        Effect.gen(function* resolveArtifact() {
          const state = yield* Ref.get(stateRef);
          const directory = state?.directory;
          const finished = state === null ? undefined : state.run;
          if (
            finished === null ||
            finished === undefined ||
            directory === undefined
          ) {
            return yield* Effect.fail(
              makeBrowserRpcError("run_invalid", "No Run has finished yet.")
            );
          }
          if (finished.runId !== runId) {
            return yield* Effect.fail(
              makeBrowserRpcError("run_invalid", "That Run is not loaded.")
            );
          }
          const segment =
            kind === "video"
              ? state?.video?.segments.find(
                  (candidate) => candidate.attempt === attempt
                )
              : undefined;
          if (segment === undefined || !segment.recorded) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "run_invalid",
                `Attempt ${attempt} recorded no video.`
              )
            );
          }
          // `file` is the manifest's own basename, relative to the Run's
          // directory, so nothing a caller sent reaches the path.
          return path.join(directory, path.basename(segment.file));
        }),

      changes: () => Stream.fromPubSub(updates),

      get: () =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => (state === null ? null : toSnapshot(state)))
        ),

      loadFlow: (document, source) =>
        Effect.gen(function* loadFlow() {
          const state = yield* Ref.get(stateRef);
          // A Run in flight owns the snapshot the browser is watching, so the
          // Flow under it is not swapped out from beneath it.
          if (state !== null && runIsInFlight(toSnapshot(state))) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "run_conflict",
                "A Run is in progress. Wait for it to finish before loading another Flow."
              )
            );
          }
          const decoded = yield* Effect.result(
            decodeFlowDocument(document, source)
          );
          if (decoded._tag === "Failure") {
            return yield* Effect.fail(
              makeBrowserRpcError("run_invalid", decoded.failure.message)
            );
          }
          // A loaded Flow starts from nothing: the previous Flow's Run, its
          // artifacts and its warnings describe a different Flow.
          const loaded = idleState(decoded.success);
          yield* Ref.set(stateRef, loaded);
          yield* PubSub.publish(updates, toSnapshot(loaded));
          return toSnapshot(loaded);
        }),

      start: () =>
        Effect.gen(function* startRun() {
          const state = yield* requireFlow();
          // Not a second notion of "one Run at a time": the Runner's semaphore
          // remains the enforcement, and this only refuses to *ask* it. Without
          // the refusal a second request would fork a Run that blocks on the
          // permit, leaving the interface saying `starting` indefinitely with
          // nothing to explain it. Both sides read the same predicate.
          if (runIsInFlight(toSnapshot(state))) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "run_conflict",
                "A Run is already in progress."
              )
            );
          }
          const started = yield* update(() => ({
            ...idleState(state.flow),
            phase: "starting" as const,
          }));
          // Forked as a daemon: the Run outlives the request that asked for
          // it, and a browser that navigates away must not interrupt a Run
          // mid-Step and leave a half-written Trace.
          yield* Effect.forkDetach(
            execute(state.flow).pipe(
              Effect.catchCause(() =>
                update((current) => ({
                  ...current,
                  error: "The Run ended unexpectedly.",
                  phase: "idle",
                  variablePrompt: null,
                })).pipe(Effect.asVoid)
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem)
            )
          );
          return started ?? toSnapshot(state);
        }),
    };

    return service;
  });

export const makeRunSessionLayer = (
  input: RunSessionInput
): Layer.Layer<
  RunSessionService,
  never,
  FileSystem.FileSystem | RunnerService
> => Layer.effect(RunSession, makeRunSessionService(input));
