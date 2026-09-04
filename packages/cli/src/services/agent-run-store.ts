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

/**
 * Contingency's own defaults, used when the Catalog Root declares no policy.
 * They are explicit values rather than an inherited library timeout
 * ([ADR 0021](../../../../docs/adr/0021-timeouts-are-set-not-inherited.md)).
 */
export const DEFAULT_AGENT_STEP_CEILING_MS = 120_000;
export const DEFAULT_AGENT_RUN_CEILING_MS = 900_000;

const CONFIG_FILE = "agent-flow-catalog.json";

/**
 * The Catalog Root's ceiling policy. Every key is optional and an unreadable
 * or partial file falls back to the defaults: a Run must not fail to start
 * because an operator mistyped a budget.
 */
const AgentRunCeilingPolicy = Schema.Struct({
  runCeilingMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  stepCeilingMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

const CatalogRunConfiguration = Schema.Struct({
  agentRunCeilings: Schema.optional(AgentRunCeilingPolicy),
});

export interface AgentRunCeilingDefaults {
  readonly runMs: number;
  readonly stepMs: number;
}

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
  readonly write: (
    summary: AgentRunSummary
  ) => Effect.Effect<AgentRunSummary, AgentRunStoreError>;
  /** The absolute path of a persisted Run's video, or `null` when it has none. */
  readonly videoFile: (
    runId: AgentRunId
  ) => Effect.Effect<string | null, AgentRunStoreError>;
  readonly ceilings: () => Effect.Effect<
    AgentRunCeilingDefaults,
    AgentRunStoreError
  >;
}

export const AgentRunStore = Context.Service<AgentRunStoreService>(
  "@contingency/AgentRunStore"
);

export interface AgentRunStoreOptions {
  /** Read on every call, so selecting another Catalog Root takes effect. */
  readonly root: () => string;
}

const encodeSummary = Schema.encodeSync(AgentRunSummary);
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
        try: () => JSON.parse(contents) as unknown,
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

  const write = (summary: AgentRunSummary) =>
    Effect.gen(function* writeSummary() {
      const directory = yield* prepare(summary.runId);
      yield* fileSystem
        .writeFileString(
          path.join(directory, SUMMARY_FILE),
          `${JSON.stringify(encodeSummary(summary), null, 2)}\n`
        )
        .pipe(
          Effect.mapError(
            ioError(`Could not write the Run Summary for ${summary.runId}`)
          )
        );
      return summary;
    });

  const videoFile = (runId: AgentRunId) =>
    read(runId).pipe(
      Effect.map((summary) =>
        summary.videoPath === null
          ? null
          : path.join(runDirectory(runId), summary.videoPath)
      )
    );

  const ceilings = () =>
    Effect.gen(function* readCeilings() {
      const fallback = {
        runMs: DEFAULT_AGENT_RUN_CEILING_MS,
        stepMs: DEFAULT_AGENT_STEP_CEILING_MS,
      };
      const file = path.join(options.root(), CONFIG_FILE);
      const exists = yield* fileSystem
        .exists(file)
        .pipe(Effect.mapError(ioError("Could not inspect Catalog policy")));
      if (!exists) {
        return fallback;
      }
      const configured = yield* Effect.result(
        fileSystem.readFileString(file).pipe(
          Effect.mapError(ioError("Could not read Catalog policy")),
          Effect.flatMap((contents) =>
            Effect.try({
              catch: () =>
                storeError("agent_run_invalid", `${file} is not valid JSON.`),
              try: () => JSON.parse(contents) as unknown,
            })
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(CatalogRunConfiguration))
        )
      );
      if (configured._tag === "Failure") {
        yield* Effect.logWarning(
          "The Catalog Root's Agent Run ceiling policy is unreadable; Contingency's defaults apply.",
          configured.failure
        );
        return fallback;
      }
      const policy = configured.success.agentRunCeilings;
      return {
        runMs: policy?.runCeilingMs ?? fallback.runMs,
        stepMs: policy?.stepCeilingMs ?? fallback.stepMs,
      };
    });

  return AgentRunStore.of({ ceilings, prepare, read, videoFile, write });
});

export const makeAgentRunStoreLayer = (
  options: AgentRunStoreOptions
): Layer.Layer<AgentRunStoreService, never, FileSystem.FileSystem> =>
  Layer.effect(AgentRunStore, makeAgentRunStore(options));
