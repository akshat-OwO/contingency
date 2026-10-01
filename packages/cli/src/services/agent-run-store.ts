import path from "node:path";

import { AgentRunSummary } from "@contingency/protocol";
import type { AgentRunId } from "@contingency/protocol";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

/** One directory per Interactive Run, under the selected Catalog Root. */
export const AGENT_RUNS_DIRECTORY = "agent-runs";

const SUMMARY_FILE = "summary.json";
export const AGENT_RUN_VIDEO_FILE = "run.webm";
export const AGENT_RUN_TRACE_FILE = "run.trace.zip";

interface AgentRunStoreDomainError {
  readonly _tag: "AgentRunStoreError";
  readonly code: "agent_run_invalid" | "agent_run_io" | "agent_run_not_found";
  readonly message: string;
}
export type AgentRunStoreError = AgentRunStoreDomainError;

const storeError = (
  code: AgentRunStoreDomainError["code"],
  message: string
): AgentRunStoreError => ({ _tag: "AgentRunStoreError", code, message });

const ioError = (context: string) => (cause: PlatformError) =>
  storeError("agent_run_io", `${context}: ${cause.message}`);

export interface AgentRunStoreService {
  /**
   * The Run's own directory, created if absent. Artifacts are written straight
   * into it so a finished Run is one self-contained package.
   */
  readonly prepare: (
    runId: AgentRunId
  ) => Effect.Effect<string, AgentRunStoreError>;
  readonly read: (
    runId: AgentRunId
  ) => Effect.Effect<AgentRunSummary, AgentRunStoreError>;
  readonly write: <Summary extends AgentRunSummary>(
    summary: Summary
  ) => Effect.Effect<Summary, AgentRunStoreError>;
  /** The absolute path of a persisted Run's video, or `null` when it has none. */
  readonly videoFile: (
    runId: AgentRunId
  ) => Effect.Effect<string | null, AgentRunStoreError>;
}

export const AgentRunStore = Context.Service<AgentRunStoreService>(
  "@contingency/AgentRunStore"
);

export interface AgentRunStoreOptions {
  /** Read on every call, so selecting another Catalog Root takes effect. */
  readonly root: () => string;
}

const encodeSummary = Schema.encodeEffect(AgentRunSummary);
const decodeSummary = Schema.decodeUnknownEffect(AgentRunSummary);

const makeAgentRunStore = Effect.fn("AgentRunStore.make")(function* makeStore(
  options: AgentRunStoreOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const runDirectory = (runId: AgentRunId): string =>
    path.join(options.root(), AGENT_RUNS_DIRECTORY, runId);

  const prepare = (runId: AgentRunId) =>
    fileSystem
      .makeDirectory(runDirectory(runId), { recursive: true })
      .pipe(
        Effect.mapError(ioError(`Could not create the directory for ${runId}`)),
        Effect.as(runDirectory(runId))
      );

  const read = (runId: AgentRunId) =>
    Effect.gen(function* readSummary() {
      const file = path.join(runDirectory(runId), SUMMARY_FILE);
      const exists = yield* fileSystem
        .exists(file)
        .pipe(Effect.mapError(ioError(`Could not inspect Run ${runId}`)));
      if (!exists) {
        return yield* Effect.fail(
          storeError(
            "agent_run_not_found",
            `Run ${runId} has no persisted Run Summary under ${options.root()}.`
          )
        );
      }
      const contents = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.mapError(ioError(`Could not read Run ${runId}`)));
      const parsed = yield* Effect.try({
        catch: () =>
          storeError("agent_run_invalid", `${file} is not valid JSON.`),
        try: () => JSON.parse(contents),
      });
      return yield* decodeSummary(parsed).pipe(
        Effect.mapError((cause) =>
          storeError(
            "agent_run_invalid",
            `${file} is not a valid Run Summary: ${cause.message}`
          )
        )
      );
    });

  const write = <Summary extends AgentRunSummary>(summary: Summary) =>
    Effect.gen(function* writeSummary() {
      const encoded = yield* encodeSummary(summary).pipe(
        Effect.mapError((cause) =>
          storeError(
            "agent_run_invalid",
            `Run ${summary.runId} is not a valid Run Summary: ${cause.message}`
          )
        )
      );
      const directory = yield* prepare(summary.runId);
      yield* fileSystem
        .writeFileString(
          path.join(directory, SUMMARY_FILE),
          `${JSON.stringify(encoded, null, 2)}\n`
        )
        .pipe(
          Effect.mapError(
            ioError(`Could not write the Run Summary for ${summary.runId}`)
          )
        );
      return summary;
    });

  // The stored path is relative to the Run's own directory. A summary is
  // written that way, but this store also reads files another process wrote,
  // so containment is checked on read too: a path that escapes the Run
  // directory resolves to no video rather than to a file elsewhere on disk.
  const videoFile = (runId: AgentRunId) =>
    read(runId).pipe(
      Effect.map((summary) => {
        if (summary.videoPath === null) {
          return null;
        }
        const directory = runDirectory(runId);
        const resolved = path.resolve(directory, summary.videoPath);
        const relative = path.relative(directory, resolved);
        return relative.startsWith("..") || path.isAbsolute(relative)
          ? null
          : resolved;
      })
    );

  return AgentRunStore.of({ prepare, read, videoFile, write });
});

export const makeAgentRunStoreLayer = (
  options: AgentRunStoreOptions
): Layer.Layer<AgentRunStoreService, never, FileSystem.FileSystem> =>
  Layer.effect(AgentRunStore, makeAgentRunStore(options));
