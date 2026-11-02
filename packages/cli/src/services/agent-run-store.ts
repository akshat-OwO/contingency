import path from "node:path";

import { AgentRunSummary } from "@contingency/protocol";
import type { AgentRunId, FlowSkillName } from "@contingency/protocol";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  discoverFlows,
  maintainCatalogGitignore,
  resolveFlowDirectory,
} from "./flow-catalog-layout.ts";

/** One directory per Interactive Run, under the selected Catalog Root. */
export const AGENT_RUNS_DIRECTORY = "runs";

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
  readonly scanFile: (
    runId: AgentRunId,
    reportId: string
  ) => Effect.Effect<string | null, AgentRunStoreError>;
  /**
   * The Run's own directory, created if absent. Artifacts are written straight
   * into it so a finished Run is one self-contained package.
   */
  readonly prepare: (
    runId: AgentRunId,
    flows?: readonly FlowSkillName[]
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

  // Pin ownership at Start. Resolve the owner's name for every later write.
  const owners = new Map<
    AgentRunId,
    { root: string; flow: FlowSkillName | null }
  >();
  const catalogError = (cause: { readonly message: string }) =>
    storeError("agent_run_invalid", cause.message);

  const locate = (runId: AgentRunId) =>
    Effect.gen(function* locateRun() {
      const owner = owners.get(runId);
      const root = owner?.root ?? options.root();
      if (owner !== undefined) {
        const directory =
          owner.flow === null
            ? root
            : yield* resolveFlowDirectory(root, owner.flow, fileSystem).pipe(
                Effect.mapError(catalogError)
              );
        return path.join(directory, AGENT_RUNS_DIRECTORY, runId);
      }
      const candidates = [path.join(root, AGENT_RUNS_DIRECTORY, runId)];
      const flows = yield* discoverFlows(root, fileSystem).pipe(
        Effect.mapError(catalogError)
      );
      for (const flow of flows.values()) {
        candidates.push(path.join(flow.directory, AGENT_RUNS_DIRECTORY, runId));
      }
      const existing: string[] = [];
      for (const candidate of candidates) {
        if (
          yield* fileSystem
            .exists(candidate)
            .pipe(Effect.mapError(ioError("Could not locate Run")))
        ) {
          existing.push(candidate);
        }
      }
      if (existing.length > 1) {
        return yield* Effect.fail(
          storeError(
            "agent_run_invalid",
            `Run ${runId} exists in several directories.`
          )
        );
      }
      return existing[0] ?? path.join(root, AGENT_RUNS_DIRECTORY, runId);
    });

  const prepare = (runId: AgentRunId, flows?: readonly FlowSkillName[]) =>
    Effect.gen(function* prepareRun() {
      if (flows !== undefined && !owners.has(runId)) {
        owners.set(runId, {
          flow: flows.length === 1 ? (flows[0] ?? null) : null,
          root: options.root(),
        });
      }
      const directory = yield* locate(runId);
      yield* maintainCatalogGitignore(
        owners.get(runId)?.root ?? options.root(),
        fileSystem
      ).pipe(Effect.mapError(ioError("Could not maintain catalog ignores")));
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.mapError(
            ioError(`Could not create the directory for ${runId}`)
          )
        );
      return directory;
    });

  const read = (runId: AgentRunId) =>
    Effect.gen(function* readSummary() {
      const file = path.join(yield* locate(runId), SUMMARY_FILE);
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
    Effect.gen(function* resolveVideoFile() {
      const summary = yield* read(runId);
      if (summary.videoPath === null) {
        return null;
      }
      const directory = yield* locate(runId);
      const resolved = path.resolve(directory, summary.videoPath);
      const relative = path.relative(directory, resolved);
      return relative.startsWith("..") || path.isAbsolute(relative)
        ? null
        : resolved;
    });

  const scanFile = (runId: AgentRunId, reportId: string) =>
    Effect.gen(function* resolveScanFile() {
      const summary = yield* read(runId);
      if (summary.schemaVersion !== 3) {
        return null;
      }
      const report = summary.scanReports?.find((scan) => scan.id === reportId);
      return report?.reportPath === `scans/${reportId}.json` &&
        /^scan-[a-f0-9-]+$/u.test(reportId)
        ? path.join(yield* locate(runId), report.reportPath)
        : null;
    });

  return AgentRunStore.of({ prepare, read, scanFile, videoFile, write });
});

export const makeAgentRunStoreLayer = (
  options: AgentRunStoreOptions
): Layer.Layer<AgentRunStoreService, never, FileSystem.FileSystem> =>
  Layer.effect(AgentRunStore, makeAgentRunStore(options));
