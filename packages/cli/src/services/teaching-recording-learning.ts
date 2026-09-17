import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  TEACHING_TIMELINE_BUDGET_CHARACTERS,
  TEACHING_TIMELINE_MAX_EVENTS,
  TeachingEvent,
} from "@contingency/protocol";
import type {
  FlowSkillDiagnostic,
  FlowSkillFile,
  FlowSkillSaveResult,
  OperationId,
  TeachingKeyframeContent,
  TeachingRecordingId,
  TeachingRecordingManifest,
  TeachingRecordingSummary,
  TeachingTimeline,
  TeachingTimelineEntry,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  stampFlowSkillProvenance,
  validateFlowSkillPackage,
} from "./flow-skill-package.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { webHost } from "./teaching-demonstration.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";
import type { TeachingRecordingStoreError } from "./teaching-recording-store.ts";

const EVENTS_FILE_KIND = "events";
const SKILL_FILE = "SKILL.md";
const SKILL_LOCK_FILE = ".flow-skill.lock";
const WAIT_POLL_INTERVAL_MS = 100;

interface TeachingRecordingLearningDomainError {
  readonly _tag: "TeachingRecordingLearningError";
  readonly code:
    | "teaching_recording_conflict"
    | "teaching_recording_invalid"
    | "teaching_recording_io"
    | "teaching_recording_not_found"
    | "teaching_recording_timeout"
    | "teaching_timeline_too_large";
  readonly diagnostics: readonly FlowSkillDiagnostic[];
  readonly message: string;
}
export type TeachingRecordingLearningError =
  TeachingRecordingLearningDomainError;

const learningError = (
  code: TeachingRecordingLearningDomainError["code"],
  message: string
): TeachingRecordingLearningError => ({
  _tag: "TeachingRecordingLearningError",
  code,
  diagnostics: [],
  message,
});

/**
 * A refusal that names each broken package property. The agent fixes the exact
 * file and field rather than guessing at the whole package again.
 */
const invalidPackage = (
  diagnostics: readonly FlowSkillDiagnostic[]
): TeachingRecordingLearningError => ({
  _tag: "TeachingRecordingLearningError",
  code: "teaching_recording_invalid",
  diagnostics,
  message: `The Flow Skill package was not saved: ${diagnostics
    .map(
      (entry) => `${entry.code} at ${entry.path.join(" > ")}: ${entry.message}`
    )
    .join(" ")}`,
});

const fromStoreError = (
  cause: TeachingRecordingStoreError
): TeachingRecordingLearningError => learningError(cause.code, cause.message);

const ioError = (context: string) => (cause: PlatformError) =>
  learningError("teaching_recording_io", `${context}: ${cause.message}`);

const ProcessError = Schema.Struct({ code: Schema.optional(Schema.String) });

const processIsStale = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Schema.decodeUnknownOption(ProcessError)(error).pipe(
      Option.exists(({ code }) => code === "ESRCH")
    );
  }
};

const summaryOf = (
  manifest: TeachingRecordingManifest
): TeachingRecordingSummary | undefined => {
  const { lifecycle } = manifest;
  switch (lifecycle._tag) {
    case "recording":
    case "ready":
    case "learning":
    case "skill-drafted":
    case "dry-running":
    case "dry-run-passed":
    case "verified": {
      return {
        cleanup: manifest.cleanup,
        failure: null,
        flowSkillName: manifest.flowSkillName,
        lifecycle: lifecycle._tag,
        recordingId: manifest.recordingId,
        updatedAt: manifest.updatedAt,
      };
    }
    case "dry-run-failed": {
      return {
        cleanup: manifest.cleanup,
        failure: lifecycle.dryRunResult.observableOutcome,
        flowSkillName: manifest.flowSkillName,
        lifecycle: lifecycle._tag,
        recordingId: manifest.recordingId,
        updatedAt: manifest.updatedAt,
      };
    }
    case "failed": {
      return {
        cleanup: manifest.cleanup,
        failure: lifecycle.error,
        flowSkillName: manifest.flowSkillName,
        lifecycle: "failed",
        recordingId: manifest.recordingId,
        updatedAt: manifest.updatedAt,
      };
    }
    default: {
      return undefined;
    }
  }
};

const isSafeSkillPath = (filePath: string): boolean => {
  if (filePath.includes("\\")) {
    return false;
  }
  const normalized = path.posix.normalize(filePath);
  return (
    normalized === filePath &&
    (filePath === SKILL_FILE || filePath.startsWith("references/")) &&
    !filePath.endsWith("/") &&
    !path.posix.isAbsolute(filePath) &&
    !filePath.split("/").includes("..")
  );
};

const pathDiagnostic = (
  code: string,
  message: string,
  filePath: string
): FlowSkillDiagnostic => ({ code, message, path: [filePath] });

const validateFiles = (
  files: readonly FlowSkillFile[]
): Effect.Effect<readonly FlowSkillFile[], TeachingRecordingLearningError> => {
  const missingSkillFile = pathDiagnostic(
    "flow_skill_missing_skill_file",
    "A Flow Skill package must contain SKILL.md.",
    SKILL_FILE
  );
  if (files.length === 0) {
    return Effect.fail(invalidPackage([missingSkillFile]));
  }
  const names = new Set<string>();
  for (const file of files) {
    if (!isSafeSkillPath(file.path)) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_skill_unsafe_path",
            `Flow Skill file ${file.path} must be SKILL.md or a file under references/.`,
            file.path
          ),
        ])
      );
    }
    if (file.content.trim().length === 0) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_skill_empty_file",
            `Flow Skill file ${file.path} must not be empty.`,
            file.path
          ),
        ])
      );
    }
    if (names.has(file.path)) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_skill_duplicate_file",
            `Flow Skill file ${file.path} appears more than once.`,
            file.path
          ),
        ])
      );
    }
    names.add(file.path);
  }
  return names.has(SKILL_FILE)
    ? Effect.succeed(files)
    : Effect.fail(invalidPackage([missingSkillFile]));
};

const eventProjection = (
  event: TeachingEvent,
  manifest: TeachingRecordingManifest
): Effect.Effect<TeachingTimelineEntry, TeachingRecordingLearningError> => {
  switch (event._tag) {
    case "started": {
      return Effect.succeed({
        ...event,
        url: sanitizeTeachingUrl(event.url),
      });
    }
    case "action": {
      return Effect.succeed({
        ...event,
        after: { ...event.after, url: sanitizeTeachingUrl(event.after.url) },
        before: {
          ...event.before,
          url: sanitizeTeachingUrl(event.before.url),
        },
        target:
          event.target?.valueWithheld === true
            ? { ...event.target, value: null }
            : event.target,
      });
    }
    case "url": {
      return Effect.succeed({
        ...event,
        from: sanitizeTeachingUrl(event.from),
        url: sanitizeTeachingUrl(event.url),
      });
    }
    case "keyframe": {
      const artifact = manifest.artifacts.find(
        (candidate) =>
          candidate.kind === "keyframe" &&
          candidate.hash === event.hash &&
          candidate.path === event.path
      );
      return artifact === undefined
        ? Effect.fail(
            learningError(
              "teaching_recording_invalid",
              `Teaching Recording ${manifest.recordingId} references an unknown keyframe.`
            )
          )
        : Effect.succeed({
            _tag: "keyframe",
            actionId: event.actionId,
            at: event.at,
            hash: event.hash,
            id: artifact.id,
            seq: event.seq,
          });
    }
    default: {
      return Effect.succeed(event);
    }
  }
};

export interface SaveFlowSkillInput {
  readonly claimOperationId: OperationId;
  readonly files: readonly FlowSkillFile[];
  readonly operationId: OperationId;
  readonly recordingId: TeachingRecordingId;
}

export interface TeachingTimelineInput {
  readonly claimOperationId: OperationId;
  readonly cursor: number;
  readonly recordingId: TeachingRecordingId;
}

export interface TeachingRecordingLearningService {
  readonly keyframe: (
    recordingId: TeachingRecordingId,
    claimOperationId: OperationId,
    keyframeId: string
  ) => Effect.Effect<TeachingKeyframeContent, TeachingRecordingLearningError>;
  readonly list: () => Effect.Effect<
    readonly TeachingRecordingSummary[],
    TeachingRecordingLearningError
  >;
  readonly save: (
    input: SaveFlowSkillInput
  ) => Effect.Effect<FlowSkillSaveResult, TeachingRecordingLearningError>;
  readonly timeline: (
    input: TeachingTimelineInput
  ) => Effect.Effect<TeachingTimeline, TeachingRecordingLearningError>;
  readonly wait: (
    recordingId: TeachingRecordingId,
    timeoutMs: number
  ) => Effect.Effect<TeachingRecordingSummary, TeachingRecordingLearningError>;
}

export const TeachingRecordingLearning =
  Context.Service<TeachingRecordingLearningService>(
    "@contingency/TeachingRecordingLearning"
  );

const makeTeachingRecordingLearning = Effect.fn(
  "TeachingRecordingLearning.make"
)(function* makeLearningService() {
  const fileSystem = yield* FileSystem.FileSystem;
  const store = yield* TeachingRecordingStore;

  const readEvents = (
    manifest: TeachingRecordingManifest
  ): Effect.Effect<readonly TeachingEvent[], TeachingRecordingLearningError> =>
    Effect.gen(function* decodeEventStream() {
      const artifact = manifest.artifacts.find(
        (candidate) => candidate.kind === EVENTS_FILE_KIND
      );
      if (artifact === undefined) {
        return yield* Effect.fail(
          learningError(
            "teaching_recording_invalid",
            `Teaching Recording ${manifest.recordingId} has no semantic event stream.`
          )
        );
      }
      const contents = yield* fileSystem
        .readFileString(
          path.join(store.directory(manifest.recordingId), artifact.path)
        )
        .pipe(
          Effect.mapError(
            ioError(
              `Could not read the semantic timeline for ${manifest.recordingId}`
            )
          )
        );
      const lines = contents.split("\n").filter((line) => line.length > 0);
      return yield* Effect.forEach(
        lines.map((line, index) => ({ index, line })),
        ({ index, line }) =>
          Effect.try({
            catch: () =>
              learningError(
                "teaching_recording_invalid",
                `Teaching Recording ${manifest.recordingId} has invalid JSON on event line ${index + 1}.`
              ),
            try: () => JSON.parse(line),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(TeachingEvent)),
            Effect.mapError((cause) =>
              cause._tag === "TeachingRecordingLearningError"
                ? cause
                : learningError(
                    "teaching_recording_invalid",
                    `Teaching Recording ${manifest.recordingId} has an invalid event on line ${index + 1}.`
                  )
            )
          )
      );
    });

  const list = () =>
    store.listReady().pipe(
      Effect.map((manifests) =>
        manifests.flatMap((manifest) => {
          const summary = summaryOf(manifest);
          return summary === undefined ? [] : [summary];
        })
      ),
      Effect.mapError(fromStoreError)
    );

  const wait = (recordingId: TeachingRecordingId, timeoutMs: number) =>
    Effect.gen(function* waitForRecording() {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const result = yield* Effect.result(store.read(recordingId));
        if (Result.isSuccess(result)) {
          const summary = summaryOf(result.success);
          if (summary !== undefined) {
            return summary;
          }
        } else if (result.failure.code !== "teaching_recording_not_found") {
          return yield* Effect.fail(fromStoreError(result.failure));
        }
        yield* Effect.sleep(WAIT_POLL_INTERVAL_MS);
      }
      return yield* Effect.fail(
        learningError(
          "teaching_recording_timeout",
          `Teaching Recording ${recordingId} did not start or finish within ${timeoutMs} ms.`
        )
      );
    });

  const timeline = (input: TeachingTimelineInput) =>
    Effect.gen(function* readTimelinePage() {
      const manifest = yield* store
        .readClaimed(input.recordingId, input.claimOperationId)
        .pipe(Effect.mapError(fromStoreError));
      const events = yield* readEvents(manifest);
      if (input.cursor > events.length) {
        return yield* Effect.fail(
          learningError(
            "teaching_recording_invalid",
            `Timeline cursor ${input.cursor} is past the end of Teaching Recording ${input.recordingId}.`
          )
        );
      }
      const entries: TeachingTimelineEntry[] = [];
      for (const event of events.slice(input.cursor)) {
        if (entries.length >= TEACHING_TIMELINE_MAX_EVENTS) {
          break;
        }
        const projected = yield* eventProjection(event, manifest);
        const candidate = {
          entries: [...entries, projected],
          maxCharacters: TEACHING_TIMELINE_BUDGET_CHARACTERS,
          nextCursor: input.cursor + entries.length + 1,
          recordingId: input.recordingId,
        } satisfies TeachingTimeline;
        if (
          JSON.stringify(candidate).length > TEACHING_TIMELINE_BUDGET_CHARACTERS
        ) {
          if (entries.length === 0) {
            return yield* Effect.fail(
              learningError(
                "teaching_timeline_too_large",
                `Event ${event.seq} cannot fit within the ${TEACHING_TIMELINE_BUDGET_CHARACTERS}-character timeline page limit.`
              )
            );
          }
          break;
        }
        entries.push(projected);
      }
      const nextIndex = input.cursor + entries.length;
      return {
        entries,
        maxCharacters: TEACHING_TIMELINE_BUDGET_CHARACTERS,
        nextCursor: nextIndex < events.length ? nextIndex : null,
        recordingId: input.recordingId,
      } satisfies TeachingTimeline;
    });

  const keyframe = (
    recordingId: TeachingRecordingId,
    claimOperationId: OperationId,
    keyframeId: string
  ) =>
    Effect.gen(function* readOneKeyframe() {
      const manifest = yield* store
        .readClaimed(recordingId, claimOperationId)
        .pipe(Effect.mapError(fromStoreError));
      const artifact = manifest.artifacts.find(
        (candidate) =>
          candidate.kind === "keyframe" && candidate.id === keyframeId
      );
      if (artifact === undefined) {
        return yield* Effect.fail(
          learningError(
            "teaching_recording_not_found",
            `Teaching Recording ${recordingId} has no keyframe ${keyframeId}.`
          )
        );
      }
      const bytes = yield* fileSystem
        .readFile(path.join(store.directory(recordingId), artifact.path))
        .pipe(
          Effect.mapError(
            ioError(`Could not read keyframe ${keyframeId} from ${recordingId}`)
          )
        );
      return {
        format: "png",
        hash: artifact.hash,
        id: artifact.id,
        image: Buffer.from(bytes).toString("base64"),
        recordingId,
      } satisfies TeachingKeyframeContent;
    });

  const withSkillLock = <A>(
    catalogRoot: string,
    operation: Effect.Effect<A, TeachingRecordingLearningError>
  ): Effect.Effect<A, TeachingRecordingLearningError> => {
    const lockPath = path.join(catalogRoot, SKILL_LOCK_FILE);
    const conflict = learningError(
      "teaching_recording_conflict",
      "Another process is saving a Flow Skill in this Catalog Root."
    );
    const create = fileSystem
      .writeFileString(lockPath, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(Effect.mapError(() => conflict));
    return Effect.gen(function* lockSkillCatalog() {
      yield* fileSystem
        .makeDirectory(catalogRoot, { recursive: true })
        .pipe(Effect.mapError(ioError("Could not prepare the Catalog Root")));
      const first = yield* Effect.result(create);
      if (Result.isSuccess(first)) {
        return yield* operation.pipe(
          Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
        );
      }
      const observed = yield* fileSystem
        .readFileString(lockPath)
        .pipe(Effect.mapError(() => conflict));
      const owner = /^(?<pid>[1-9][0-9]*)\n$/u.exec(observed)?.groups?.pid;
      const ownerPid = owner === undefined ? 0 : Number(owner);
      if (!Number.isSafeInteger(ownerPid) || !processIsStale(ownerPid)) {
        return yield* Effect.fail(conflict);
      }
      const confirmed = yield* fileSystem
        .readFileString(lockPath)
        .pipe(Effect.mapError(() => conflict));
      if (confirmed !== observed) {
        return yield* Effect.fail(conflict);
      }
      yield* fileSystem.remove(lockPath).pipe(Effect.mapError(() => conflict));
      const retry = yield* Effect.result(create);
      if (Result.isFailure(retry)) {
        return yield* Effect.fail(conflict);
      }
      return yield* operation.pipe(
        Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
      );
    });
  };

  const save = (input: SaveFlowSkillInput) =>
    Effect.gen(function* saveFlowSkillPackage() {
      const files = yield* validateFiles(input.files);
      const existing = yield* store
        .read(input.recordingId)
        .pipe(Effect.mapError(fromStoreError));
      const replay = existing.receipts.find(
        (receipt) =>
          receipt.operation === "save-skill" &&
          receipt.operationId === input.operationId
      );
      if (replay !== undefined) {
        if (replay.files === undefined) {
          return yield* Effect.fail(
            learningError(
              "teaching_recording_invalid",
              `Teaching Recording ${input.recordingId} has an incomplete save receipt.`
            )
          );
        }
        return {
          files: replay.files,
          flowSkillName: existing.flowSkillName,
          recordingId: existing.recordingId,
        } satisfies FlowSkillSaveResult;
      }
      const manifest = yield* store
        .readClaimed(input.recordingId, input.claimOperationId)
        .pipe(Effect.mapError(fromStoreError));
      // The package contract is checked here, in the same pre-write window as
      // the path rules: an invalid package must never become the live
      // directory, so nothing is staged until every property holds.
      const validated = validateFlowSkillPackage(manifest.flowSkillName, files);
      if (Result.isFailure(validated)) {
        return yield* Effect.fail(invalidPackage(validated.failure));
      }
      // A verified Flow Skill outlives its recording, so the demonstrated host
      // ceiling and device are stamped into the package now, while the event
      // stream is still on disk to prove them.
      const events = yield* readEvents(manifest);
      const visited = new Set<string>();
      for (const event of events) {
        if (event._tag !== "started" && event._tag !== "url") {
          continue;
        }
        const host = webHost(event.url);
        if (host !== undefined) {
          visited.add(host);
        }
      }
      const demonstratedHosts = [...visited].toSorted();
      const stamped = files.map((file) =>
        file.path === SKILL_FILE
          ? {
              ...file,
              content: stampFlowSkillProvenance(file.content, {
                emulation: {
                  colorScheme: manifest.emulation.colorScheme ?? undefined,
                  locale: manifest.emulation.locale ?? undefined,
                  timezone: manifest.emulation.timezoneId ?? undefined,
                  userAgentProfile: manifest.emulation.userAgentProfile,
                  viewport: manifest.emulation.viewport,
                },
                hosts: demonstratedHosts,
              }),
            }
          : file
      );
      const recordingDirectory = store.directory(input.recordingId);
      const catalogRoot = path.dirname(path.dirname(recordingDirectory));
      return yield* withSkillLock(
        catalogRoot,
        Effect.gen(function* replaceSkillAtomically() {
          const nonce = randomUUID();
          const temporary = path.join(catalogRoot, `.flow-skill-${nonce}.tmp`);
          const backup = path.join(catalogRoot, `.flow-skill-${nonce}.backup`);
          const target = path.join(catalogRoot, manifest.flowSkillName);
          yield* fileSystem
            .makeDirectory(temporary, { mode: 0o700, recursive: true })
            .pipe(Effect.mapError(ioError("Could not stage the Flow Skill")));
          const staged = yield* Effect.result(
            Effect.forEach(
              stamped,
              (file) => {
                const destination = path.join(temporary, file.path);
                return fileSystem
                  .makeDirectory(path.dirname(destination), { recursive: true })
                  .pipe(
                    Effect.andThen(
                      fileSystem.writeFileString(destination, file.content, {
                        mode: 0o600,
                      })
                    ),
                    Effect.mapError(
                      ioError(`Could not stage Flow Skill file ${file.path}`)
                    )
                  );
              },
              { discard: true }
            )
          );
          if (Result.isFailure(staged)) {
            yield* fileSystem
              .remove(temporary, { force: true, recursive: true })
              .pipe(Effect.ignore);
            return yield* Effect.fail(staged.failure);
          }
          const hadPrevious = yield* fileSystem
            .exists(target)
            .pipe(Effect.mapError(ioError("Could not inspect the Flow Skill")));
          if (hadPrevious) {
            const backedUp = yield* Effect.result(
              fileSystem
                .rename(target, backup)
                .pipe(
                  Effect.mapError(ioError("Could not back up the Flow Skill"))
                )
            );
            if (Result.isFailure(backedUp)) {
              yield* fileSystem
                .remove(temporary, { force: true, recursive: true })
                .pipe(Effect.ignore);
              return yield* Effect.fail(backedUp.failure);
            }
          }
          const installed = yield* Effect.result(
            fileSystem
              .rename(temporary, target)
              .pipe(
                Effect.mapError(ioError("Could not install the Flow Skill"))
              )
          );
          if (Result.isFailure(installed)) {
            yield* fileSystem
              .remove(temporary, { force: true, recursive: true })
              .pipe(Effect.ignore);
            if (hadPrevious) {
              yield* fileSystem
                .rename(backup, target)
                .pipe(
                  Effect.mapError(
                    ioError("Could not restore the previous Flow Skill")
                  )
                );
            }
            return yield* Effect.fail(installed.failure);
          }
          const recorded = yield* Effect.result(
            store.saveSkill({
              claimOperationId: input.claimOperationId,
              files: files.map((file) => file.path),
              operationId: input.operationId,
              recordingId: input.recordingId,
              skillPath: `${manifest.flowSkillName}/${SKILL_FILE}`,
            })
          );
          if (Result.isFailure(recorded)) {
            yield* fileSystem
              .remove(target, { force: true, recursive: true })
              .pipe(
                Effect.mapError(
                  ioError("Could not remove the refused Flow Skill")
                )
              );
            if (hadPrevious) {
              yield* fileSystem
                .rename(backup, target)
                .pipe(
                  Effect.mapError(
                    ioError("Could not restore the previous Flow Skill")
                  )
                );
            }
            return yield* Effect.fail(fromStoreError(recorded.failure));
          }
          if (hadPrevious) {
            yield* fileSystem
              .remove(backup, { force: true, recursive: true })
              .pipe(Effect.ignore);
          }
          return {
            files: files.map((file) => file.path),
            flowSkillName: manifest.flowSkillName,
            recordingId: manifest.recordingId,
          } satisfies FlowSkillSaveResult;
        })
      );
    });

  return TeachingRecordingLearning.of({ keyframe, list, save, timeline, wait });
});

export const TeachingRecordingLearningLive = Layer.effect(
  TeachingRecordingLearning,
  makeTeachingRecordingLearning()
);
