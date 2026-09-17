import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentSessionId,
  DraftEmulation,
  FlowSkillDryRunResult,
  FlowSkillName,
  TeachingRecordingArtifact,
  TeachingRecordingId,
  TeachingRecordingManifest,
  TeachingRecordingOperation,
} from "@contingency/protocol";
import {
  OperationId,
  TeachingRecordingId as RecordingIdSchema,
  TeachingRecordingManifest as ManifestSchema,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

export const TEACHING_RECORDINGS_DIRECTORY = ".recordings";
const MANIFEST_FILE = "manifest.json";
const LOCK_FILE = ".manifest.lock";
const VERIFICATION_FILE = "references/verification.md";
const VERIFIED_REFERENCE_PATTERN = /^- Verified: /mu;

interface TeachingRecordingStoreDomainError {
  readonly _tag: "TeachingRecordingStoreError";
  readonly code:
    | "teaching_recording_conflict"
    | "teaching_recording_invalid"
    | "teaching_recording_io"
    | "teaching_recording_not_found";
  readonly message: string;
}
export type TeachingRecordingStoreError = TeachingRecordingStoreDomainError;

const storeError = (
  code: TeachingRecordingStoreDomainError["code"],
  message: string
): TeachingRecordingStoreError => ({
  _tag: "TeachingRecordingStoreError",
  code,
  message,
});

const ioError = (context: string) => (cause: PlatformError) =>
  storeError("teaching_recording_io", `${context}: ${cause.message}`);

export interface TeachingRecordingBegin {
  readonly emulation: DraftEmulation;
  readonly flowSkillName: FlowSkillName;
  readonly operationId: OperationId;
  readonly recordingId: TeachingRecordingId;
  readonly sessionId: AgentSessionId;
}

export interface TeachingRecordingMutation {
  readonly operationId: OperationId;
  readonly recordingId: TeachingRecordingId;
}

export interface TeachingRecordingDryRunStart extends TeachingRecordingMutation {
  readonly inputs: FlowSkillDryRunResult["inputs"];
  readonly sessionId: AgentSessionId;
}

export interface TeachingRecordingDryRunReport extends TeachingRecordingMutation {
  readonly observableOutcome: string;
}

export interface TeachingRecordingStop extends TeachingRecordingMutation {
  readonly artifacts: readonly TeachingRecordingArtifact[];
  /** Capture ended, but the retained artifacts may still be recovered. */
  readonly failure?: string | undefined;
}

export interface TeachingRecordingSkillDraft extends TeachingRecordingMutation {
  readonly claimOperationId: OperationId;
  readonly files: readonly string[];
  readonly skillPath: string;
}

export interface TeachingRecordingClaimMutation extends TeachingRecordingMutation {
  readonly claimOperationId: OperationId;
}

export interface TeachingRecordingLearningFailure extends TeachingRecordingClaimMutation {
  readonly error: string;
}

export interface TeachingRecordingRename extends TeachingRecordingMutation {
  readonly flowSkillName: FlowSkillName;
}

export interface TeachingRecordingStoreService {
  readonly begin: (
    input: TeachingRecordingBegin
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly cleanup: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  /**
   * Throw away a recording the user does not want to keep. The captured
   * artifacts are removed and the bundle returns to `setup`, so the same
   * browser setup can record again without carrying the discarded evidence.
   */
  readonly discard: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly directory: (recordingId: TeachingRecordingId) => string;
  readonly listReady: () => Effect.Effect<
    readonly TeachingRecordingManifest[],
    TeachingRecordingStoreError
  >;
  readonly read: (
    recordingId: TeachingRecordingId
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly readClaimed: (
    recordingId: TeachingRecordingId,
    claimOperationId: OperationId
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly failLearning: (
    input: TeachingRecordingLearningFailure
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly failDryRun: (
    input: TeachingRecordingDryRunReport
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly releaseLearning: (
    input: TeachingRecordingClaimMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  /** Rename the Flow Skill a bundle is for, before anything is captured. */
  readonly rename: (
    input: TeachingRecordingRename
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly start: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly stop: (
    input: TeachingRecordingStop
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly startDryRun: (
    input: TeachingRecordingDryRunStart
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly startLearning: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly passDryRun: (
    input: TeachingRecordingDryRunReport
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly reject: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly saveSkill: (
    input: TeachingRecordingSkillDraft
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly verify: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
}

export const TeachingRecordingStore =
  Context.Service<TeachingRecordingStoreService>(
    "@contingency/TeachingRecordingStore"
  );

export interface TeachingRecordingStoreOptions {
  readonly now?: () => Date;
  readonly root: () => string;
}

const encodeManifest = Schema.encodeSync(ManifestSchema);
const decodeManifest = Schema.decodeUnknownEffect(ManifestSchema);
type PendingTeachingRecordingManifest = Extract<
  TeachingRecordingManifest,
  { readonly cleanup: { readonly _tag: "pending" } }
>;

const isPendingManifest = (
  manifest: TeachingRecordingManifest
): manifest is PendingTeachingRecordingManifest =>
  manifest.cleanup._tag === "pending";

const hasReceipt = (
  manifest: TeachingRecordingManifest,
  operation: TeachingRecordingOperation,
  operationId: OperationId
): boolean =>
  manifest.receipts.some(
    (receipt) =>
      receipt.operation === operation && receipt.operationId === operationId
  );

const withReceipt = (
  manifest: TeachingRecordingManifest,
  operation: TeachingRecordingOperation,
  operationId: OperationId,
  completedAt: string,
  files?: readonly string[]
): TeachingRecordingManifest => {
  const receipt = { completedAt, operation, operationId };
  return {
    ...manifest,
    receipts: [
      ...manifest.receipts,
      files === undefined ? receipt : { ...receipt, files },
    ],
    updatedAt: completedAt,
  };
};

const ProcessError = Schema.Struct({ code: Schema.optional(Schema.String) });

/** EPERM means the process exists; only ESRCH proves the claim is abandoned. */
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

const ownsClaim = (
  manifest: PendingTeachingRecordingManifest,
  claimOperationId: OperationId
): boolean =>
  manifest.lifecycle._tag === "learning" &&
  manifest.lifecycle.claim.ownerPid === process.pid &&
  manifest.lifecycle.claim.operationId === claimOperationId;

const makeTeachingRecordingStore = Effect.fn("TeachingRecordingStore.make")(
  function* makeStore(options: TeachingRecordingStoreOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const now = options.now ?? (() => new Date());
    const locks = new Map<TeachingRecordingId, Semaphore.Semaphore>();
    const purged = new Map<TeachingRecordingId, TeachingRecordingManifest>();
    const recordingRoots = new Map<TeachingRecordingId, string>();

    const rootFor = (recordingId: TeachingRecordingId): string =>
      recordingRoots.get(recordingId) ?? options.root();
    const recordingsDirectory = (root = options.root()): string =>
      path.join(root, TEACHING_RECORDINGS_DIRECTORY);
    const recordingDirectory = (
      recordingId: TeachingRecordingId,
      root = rootFor(recordingId)
    ): string => path.join(recordingsDirectory(root), recordingId);
    const manifestFile = (
      recordingId: TeachingRecordingId,
      root = rootFor(recordingId)
    ): string =>
      path.join(recordingDirectory(recordingId, root), MANIFEST_FILE);
    const manifestLockFile = (
      recordingId: TeachingRecordingId,
      root = rootFor(recordingId)
    ): string => path.join(recordingDirectory(recordingId, root), LOCK_FILE);
    const lockFor = (recordingId: TeachingRecordingId): Semaphore.Semaphore => {
      const existing = locks.get(recordingId);
      if (existing !== undefined) {
        return existing;
      }
      const created = Semaphore.makeUnsafe(1);
      locks.set(recordingId, created);
      return created;
    };

    const validateArtifactPaths = (
      manifest: TeachingRecordingManifest
    ): Effect.Effect<
      TeachingRecordingManifest,
      TeachingRecordingStoreError
    > => {
      const directory = recordingDirectory(manifest.recordingId);
      const invalid = manifest.artifacts.find((artifact) => {
        const resolved = path.resolve(directory, artifact.path);
        const relative = path.relative(directory, resolved);
        return relative.startsWith("..") || path.isAbsolute(relative);
      });
      return invalid === undefined
        ? Effect.succeed(manifest)
        : Effect.fail(
            storeError(
              "teaching_recording_invalid",
              `Recording ${manifest.recordingId} has an artifact outside its directory: ${invalid.path}`
            )
          );
    };

    const recordingLockConflict = (recordingId: TeachingRecordingId) =>
      storeError(
        "teaching_recording_conflict",
        `Teaching Recording ${recordingId} is being changed by another process.`
      );

    /** Serialize manifest compare-and-swap mutations across MCP processes. */
    const withDiskLock = <A, E>(
      recordingId: TeachingRecordingId,
      operation: Effect.Effect<A, E>,
      createDirectory = false
    ): Effect.Effect<A, E | TeachingRecordingStoreError> => {
      const directory = recordingDirectory(recordingId);
      const lockPath = manifestLockFile(recordingId);
      const conflict = recordingLockConflict(recordingId);
      const create = fileSystem
        .writeFileString(lockPath, `${process.pid}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(Effect.mapError(() => conflict));
      return Effect.gen(function* lockManifest() {
        if (createDirectory) {
          yield* fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.mapError(
                ioError(`Could not prepare Teaching Recording ${recordingId}`)
              )
            );
        } else if (
          !(yield* fileSystem
            .exists(directory)
            .pipe(
              Effect.mapError(
                ioError(`Could not inspect Teaching Recording ${recordingId}`)
              )
            ))
        ) {
          return yield* Effect.fail(
            storeError(
              "teaching_recording_not_found",
              `Teaching Recording ${recordingId} was not found.`
            )
          );
        }
        const firstAttempt = yield* Effect.result(create);
        if (Result.isSuccess(firstAttempt)) {
          return yield* operation.pipe(
            Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
          );
        }
        const observed = yield* fileSystem
          .readFileString(lockPath)
          .pipe(Effect.mapError(() => conflict));
        const ownerPid = /^(?<pid>[1-9][0-9]*)\n$/u.exec(observed)?.groups?.pid;
        const parsedPid = ownerPid === undefined ? 0 : Number(ownerPid);
        if (!Number.isSafeInteger(parsedPid) || !processIsStale(parsedPid)) {
          return yield* Effect.fail(conflict);
        }
        const confirmed = yield* fileSystem
          .readFileString(lockPath)
          .pipe(Effect.mapError(() => conflict));
        if (confirmed !== observed) {
          return yield* Effect.fail(conflict);
        }
        yield* fileSystem
          .remove(lockPath)
          .pipe(Effect.mapError(() => conflict));
        const retry = yield* Effect.result(create);
        if (Result.isFailure(retry)) {
          return yield* Effect.fail(conflict);
        }
        return yield* operation.pipe(
          Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
        );
      });
    };

    const withRecordingLock = <A, E>(
      recordingId: TeachingRecordingId,
      operation: Effect.Effect<A, E>,
      createDirectory = false
    ): Effect.Effect<A, E | TeachingRecordingStoreError> =>
      lockFor(recordingId).withPermit(
        withDiskLock(recordingId, operation, createDirectory)
      );

    const readAt = (recordingId: TeachingRecordingId, root: string) =>
      Effect.gen(function* readManifest() {
        const file = manifestFile(recordingId, root);
        const exists = yield* fileSystem
          .exists(file)
          .pipe(
            Effect.mapError(
              ioError(`Could not inspect Teaching Recording ${recordingId}`)
            )
          );
        if (!exists) {
          return yield* Effect.fail(
            storeError(
              "teaching_recording_not_found",
              `Teaching Recording ${recordingId} was not found under ${root}.`
            )
          );
        }
        const contents = yield* fileSystem
          .readFileString(file)
          .pipe(
            Effect.mapError(
              ioError(`Could not read Teaching Recording ${recordingId}`)
            )
          );
        const parsed = yield* Effect.try({
          catch: () =>
            storeError(
              "teaching_recording_invalid",
              `${file} is not valid JSON.`
            ),
          try: () => JSON.parse(contents),
        });
        const manifest = yield* decodeManifest(parsed).pipe(
          Effect.mapError((cause) =>
            storeError(
              "teaching_recording_invalid",
              `${file} is not a valid Teaching Recording manifest: ${cause.message}`
            )
          )
        );
        if (manifest.recordingId !== recordingId) {
          return yield* Effect.fail(
            storeError(
              "teaching_recording_invalid",
              `${file} belongs to Teaching Recording ${manifest.recordingId}.`
            )
          );
        }
        recordingRoots.set(recordingId, root);
        return yield* validateArtifactPaths(manifest);
      });

    const persist = <Manifest extends TeachingRecordingManifest>(
      manifest: Manifest
    ): Effect.Effect<Manifest, TeachingRecordingStoreError> =>
      Effect.gen(function* persistManifest() {
        const directory = recordingDirectory(manifest.recordingId);
        const file = manifestFile(manifest.recordingId);
        const temporary = `${file}.${randomUUID()}.tmp`;
        yield* fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.mapError(
              ioError(
                `Could not create the directory for ${manifest.recordingId}`
              )
            )
          );
        yield* fileSystem
          .writeFileString(
            temporary,
            `${JSON.stringify(encodeManifest(manifest), null, 2)}\n`,
            { mode: 0o600 }
          )
          .pipe(
            Effect.andThen(fileSystem.rename(temporary, file)),
            Effect.mapError(
              ioError(
                `Could not write the manifest for ${manifest.recordingId}`
              )
            ),
            Effect.ensuring(
              fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)
            )
          );
        return manifest;
      });

    const readAndRecoverAt = (recordingId: TeachingRecordingId, root: string) =>
      Effect.gen(function* readAndRecoverClaim() {
        const current = yield* readAt(recordingId, root);
        if (
          current.lifecycle._tag !== "learning" ||
          !processIsStale(current.lifecycle.claim.ownerPid)
        ) {
          return current;
        }
        return yield* withRecordingLock(
          recordingId,
          Effect.gen(function* recoverAbandonedClaim() {
            const confirmed = yield* readAt(recordingId, root);
            if (
              confirmed.lifecycle._tag !== "learning" ||
              !processIsStale(confirmed.lifecycle.claim.ownerPid)
            ) {
              return confirmed;
            }
            if (!isPendingManifest(confirmed)) {
              return yield* Effect.die(
                "A cleaned Teaching Recording carried a learning claim."
              );
            }
            const at = now().toISOString();
            return yield* persist({
              ...confirmed,
              lifecycle: {
                _tag: "ready",
                readyAt: confirmed.lifecycle.readyAt,
                startedAt: confirmed.lifecycle.startedAt,
                stoppedAt: confirmed.lifecycle.stoppedAt,
              },
              updatedAt: at,
            });
          })
        );
      });

    const read = (recordingId: TeachingRecordingId) => {
      const completed = purged.get(recordingId);
      return completed === undefined
        ? readAndRecoverAt(recordingId, rootFor(recordingId))
        : Effect.succeed(completed);
    };

    const mutate = (
      recordingId: TeachingRecordingId,
      operation: TeachingRecordingOperation,
      operationId: OperationId,
      transition: (
        manifest: PendingTeachingRecordingManifest,
        at: string
      ) => Effect.Effect<
        TeachingRecordingManifest,
        TeachingRecordingStoreError
      >,
      receiptFiles?: readonly string[]
    ) =>
      withRecordingLock(
        recordingId,
        Effect.gen(function* mutateManifest() {
          const current = yield* readAt(recordingId, rootFor(recordingId));
          if (hasReceipt(current, operation, operationId)) {
            return current;
          }
          if (!isPendingManifest(current)) {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${recordingId} was already cleaned up.`
              )
            );
          }
          const at = now().toISOString();
          const transitioned = yield* transition(current, at);
          return yield* persist(
            withReceipt(transitioned, operation, operationId, at, receiptFiles)
          );
        })
      );

    const begin = (input: TeachingRecordingBegin) =>
      withRecordingLock(
        input.recordingId,
        Effect.gen(function* beginRecording() {
          const root = options.root();
          recordingRoots.set(input.recordingId, root);
          const exists = yield* fileSystem
            .exists(manifestFile(input.recordingId, root))
            .pipe(
              Effect.mapError(
                ioError(
                  `Could not inspect Teaching Recording ${input.recordingId}`
                )
              )
            );
          if (exists) {
            const existing = yield* readAt(input.recordingId, root);
            if (
              existing.flowSkillName === input.flowSkillName &&
              hasReceipt(existing, "begin", input.operationId)
            ) {
              return existing;
            }
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} already exists.`
              )
            );
          }
          const at = now().toISOString();
          return yield* persist({
            artifacts: [],
            cleanup: { _tag: "pending" },
            createdAt: at,
            emulation: input.emulation,
            flowSkillName: input.flowSkillName,
            lifecycle: { _tag: "setup", requestedAt: at },
            receipts: [
              {
                completedAt: at,
                operation: "begin",
                operationId: input.operationId,
              },
            ],
            recordingId: input.recordingId,
            schemaVersion: 1,
            sessionId: input.sessionId,
            updatedAt: at,
          });
        }),
        true
      );

    const start = (input: TeachingRecordingMutation) =>
      withRecordingLock(
        input.recordingId,
        Effect.gen(function* startRecording() {
          const current = yield* readAt(
            input.recordingId,
            rootFor(input.recordingId)
          );
          if (hasReceipt(current, "start", input.operationId)) {
            return current;
          }
          if (!isPendingManifest(current)) {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} was already cleaned up.`
              )
            );
          }
          if (current.lifecycle._tag !== "setup") {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot start from ${current.lifecycle._tag}.`
              )
            );
          }
          const at = now().toISOString();
          return yield* persist(
            withReceipt(
              {
                ...current,
                lifecycle: { _tag: "recording", startedAt: at },
              },
              "start",
              input.operationId,
              at
            )
          );
        })
      );

    const stop = (input: TeachingRecordingStop) =>
      withRecordingLock(
        input.recordingId,
        Effect.gen(function* stopRecording() {
          const current = yield* readAt(
            input.recordingId,
            rootFor(input.recordingId)
          );
          if (hasReceipt(current, "stop", input.operationId)) {
            return current;
          }
          if (!isPendingManifest(current)) {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} was already cleaned up.`
              )
            );
          }
          let startedAt: string;
          let stoppedAt: string;
          if (current.lifecycle._tag === "recording") {
            ({ startedAt } = current.lifecycle);
            stoppedAt = now().toISOString();
          } else if (current.lifecycle._tag === "finalizing") {
            ({ startedAt, stoppedAt } = current.lifecycle);
          } else {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot stop from ${current.lifecycle._tag}.`
              )
            );
          }
          const readyAt = now().toISOString();
          const lifecycle =
            input.failure === undefined
              ? {
                  _tag: "ready" as const,
                  readyAt,
                  startedAt,
                  stoppedAt,
                }
              : {
                  _tag: "failed" as const,
                  error: input.failure,
                  failedAt: readyAt,
                };
          const ready = yield* validateArtifactPaths({
            ...current,
            artifacts: input.artifacts,
            lifecycle,
          });
          return yield* persist(
            withReceipt(ready, "stop", input.operationId, readyAt)
          );
        })
      );

    const startLearning = (input: TeachingRecordingMutation) =>
      mutate(
        input.recordingId,
        "start-learning",
        input.operationId,
        (manifest, at) => {
          const lifecycle =
            manifest.lifecycle._tag === "learning" &&
            processIsStale(manifest.lifecycle.claim.ownerPid)
              ? {
                  _tag: "ready" as const,
                  readyAt: manifest.lifecycle.readyAt,
                  startedAt: manifest.lifecycle.startedAt,
                  stoppedAt: manifest.lifecycle.stoppedAt,
                }
              : manifest.lifecycle;
          if (lifecycle._tag === "ready") {
            return Effect.succeed({
              ...manifest,
              lifecycle: {
                ...lifecycle,
                _tag: "learning" as const,
                claim: {
                  claimedAt: at,
                  operationId: input.operationId,
                  ownerPid: process.pid,
                },
              },
            });
          }
          if (
            lifecycle._tag === "skill-drafted" ||
            lifecycle._tag === "dry-run-failed"
          ) {
            return Effect.succeed({
              ...manifest,
              lifecycle: {
                _tag: "learning" as const,
                claim: {
                  claimedAt: at,
                  operationId: input.operationId,
                  ownerPid: process.pid,
                },
                readyAt: lifecycle.readyAt,
                startedAt: lifecycle.startedAt,
                stoppedAt: lifecycle.stoppedAt,
              },
            });
          }
          if (
            lifecycle._tag !== "failed" ||
            lifecycle.readyAt === undefined ||
            lifecycle.startedAt === undefined ||
            lifecycle.stoppedAt === undefined
          ) {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot start learning from ${lifecycle._tag}.`
              )
            );
          }
          return Effect.succeed({
            ...manifest,
            lifecycle: {
              _tag: "learning" as const,
              claim: {
                claimedAt: at,
                operationId: input.operationId,
                ownerPid: process.pid,
              },
              readyAt: lifecycle.readyAt,
              startedAt: lifecycle.startedAt,
              stoppedAt: lifecycle.stoppedAt,
            },
          });
        }
      );

    const readClaimed = (
      recordingId: TeachingRecordingId,
      claimOperationId: OperationId
    ) =>
      Effect.gen(function* readOwnedLearningClaim() {
        const manifest = yield* read(recordingId);
        if (
          !isPendingManifest(manifest) ||
          !ownsClaim(manifest, claimOperationId)
        ) {
          return yield* Effect.fail(
            storeError(
              "teaching_recording_conflict",
              `This process does not own the learning claim for Teaching Recording ${recordingId}.`
            )
          );
        }
        return manifest;
      });

    const releaseLearning = (input: TeachingRecordingClaimMutation) =>
      mutate(
        input.recordingId,
        "release-learning",
        input.operationId,
        (manifest) => {
          if (!ownsClaim(manifest, input.claimOperationId)) {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `This process does not own the learning claim for Teaching Recording ${input.recordingId}.`
              )
            );
          }
          const { lifecycle } = manifest;
          if (lifecycle._tag !== "learning") {
            return Effect.die(
              "The checked learning claim changed unexpectedly."
            );
          }
          return Effect.succeed({
            ...manifest,
            lifecycle: {
              _tag: "ready" as const,
              readyAt: lifecycle.readyAt,
              startedAt: lifecycle.startedAt,
              stoppedAt: lifecycle.stoppedAt,
            },
          });
        }
      );

    const failLearning = (input: TeachingRecordingLearningFailure) =>
      mutate(
        input.recordingId,
        "fail-learning",
        input.operationId,
        (manifest, at) => {
          if (!ownsClaim(manifest, input.claimOperationId)) {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `This process does not own the learning claim for Teaching Recording ${input.recordingId}.`
              )
            );
          }
          const { lifecycle } = manifest;
          if (lifecycle._tag !== "learning") {
            return Effect.die(
              "The checked learning claim changed unexpectedly."
            );
          }
          return Effect.succeed({
            ...manifest,
            lifecycle: {
              _tag: "failed" as const,
              error: input.error,
              failedAt: at,
              readyAt: lifecycle.readyAt,
              startedAt: lifecycle.startedAt,
              stoppedAt: lifecycle.stoppedAt,
            },
          });
        }
      );

    const saveSkill = (input: TeachingRecordingSkillDraft) =>
      mutate(
        input.recordingId,
        "save-skill",
        input.operationId,
        (manifest, at) => {
          if (!ownsClaim(manifest, input.claimOperationId)) {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `This process does not own the learning claim for Teaching Recording ${input.recordingId}.`
              )
            );
          }
          const { lifecycle } = manifest;
          if (lifecycle._tag !== "learning") {
            return Effect.die(
              "The checked learning claim changed unexpectedly."
            );
          }
          return Effect.succeed({
            ...manifest,
            lifecycle: {
              _tag: "skill-drafted" as const,
              draftedAt: at,
              readyAt: lifecycle.readyAt,
              skillPath: input.skillPath,
              startedAt: lifecycle.startedAt,
              stoppedAt: lifecycle.stoppedAt,
            },
          });
        },
        input.files
      );

    const startDryRun = (input: TeachingRecordingDryRunStart) =>
      mutate(
        input.recordingId,
        "start-dry-run",
        input.operationId,
        (manifest, at) => {
          const { lifecycle } = manifest;
          if (
            lifecycle._tag !== "skill-drafted" &&
            lifecycle._tag !== "dry-run-failed"
          ) {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot start a Dry Run from ${lifecycle._tag}.`
              )
            );
          }
          return Effect.succeed({
            ...manifest,
            lifecycle: {
              _tag: "dry-running" as const,
              draftedAt: lifecycle.draftedAt,
              dryRunInputs: input.inputs,
              dryRunSessionId: input.sessionId,
              dryRunStartedAt: at,
              readyAt: lifecycle.readyAt,
              skillPath: lifecycle.skillPath,
              startedAt: lifecycle.startedAt,
              stoppedAt: lifecycle.stoppedAt,
            },
          });
        }
      );

    const persistDryRunReference = (
      manifest: PendingTeachingRecordingManifest,
      result: FlowSkillDryRunResult
    ) => {
      if (manifest.lifecycle._tag !== "dry-running") {
        return Effect.fail(
          storeError(
            "teaching_recording_conflict",
            `Teaching Recording ${manifest.recordingId} has no active Dry Run.`
          )
        );
      }
      const skillDirectory = path.dirname(
        path.join(rootFor(manifest.recordingId), manifest.lifecycle.skillPath)
      );
      const verificationPath = path.join(skillDirectory, VERIFICATION_FILE);
      const inputs = result.inputs.map(
        ({ changed, name, value }) =>
          `- ${name}${changed ? " (changed)" : ""}: ${
            value === null ? "<redacted>" : JSON.stringify(value)
          }`
      );
      const contents = [
        "# Last Dry Run",
        "",
        `- Completed: ${result.completedAt}`,
        `- Result: ${result.outcome}`,
        `- Observable outcome: ${result.observableOutcome}`,
        "",
        "## Inputs",
        "",
        ...inputs,
        "",
      ].join("\n");
      return fileSystem
        .makeDirectory(path.dirname(verificationPath), { recursive: true })
        .pipe(
          Effect.andThen(
            fileSystem.writeFileString(verificationPath, contents, {
              mode: 0o600,
            })
          ),
          Effect.mapError(
            ioError(
              `Could not persist the Dry Run result for ${manifest.recordingId}`
            )
          )
        );
    };

    const reportDryRun = (
      input: TeachingRecordingDryRunReport,
      outcome: FlowSkillDryRunResult["outcome"]
    ) =>
      mutate(
        input.recordingId,
        outcome === "passed" ? "pass-dry-run" : "fail-dry-run",
        input.operationId,
        (manifest, at) =>
          Effect.gen(function* persistDryRunResult() {
            const { lifecycle } = manifest;
            if (lifecycle._tag !== "dry-running") {
              return yield* Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot report a Dry Run from ${lifecycle._tag}.`
                )
              );
            }
            const result: FlowSkillDryRunResult = {
              completedAt: at,
              inputs: lifecycle.dryRunInputs,
              observableOutcome: input.observableOutcome,
              outcome,
            };
            yield* persistDryRunReference(manifest, result);
            return {
              ...manifest,
              lifecycle: {
                _tag:
                  outcome === "passed"
                    ? ("dry-run-passed" as const)
                    : ("dry-run-failed" as const),
                draftedAt: lifecycle.draftedAt,
                dryRunEndedAt: at,
                dryRunResult: result,
                dryRunSessionId: lifecycle.dryRunSessionId,
                dryRunStartedAt: lifecycle.dryRunStartedAt,
                readyAt: lifecycle.readyAt,
                skillPath: lifecycle.skillPath,
                startedAt: lifecycle.startedAt,
                stoppedAt: lifecycle.stoppedAt,
              },
            };
          })
      );

    const passDryRun = (input: TeachingRecordingDryRunReport) =>
      reportDryRun(input, "passed");

    const failDryRun = (input: TeachingRecordingDryRunReport) =>
      reportDryRun(input, "failed");

    const markVerificationReference = (
      manifest: PendingTeachingRecordingManifest,
      verifiedAt: string
    ) => {
      if (manifest.lifecycle._tag !== "dry-run-passed") {
        return Effect.fail(
          storeError(
            "teaching_recording_conflict",
            `Teaching Recording ${manifest.recordingId} has no passing Dry Run to verify.`
          )
        );
      }
      const verificationPath = path.join(
        path.dirname(
          path.join(rootFor(manifest.recordingId), manifest.lifecycle.skillPath)
        ),
        VERIFICATION_FILE
      );
      return fileSystem.readFileString(verificationPath).pipe(
        Effect.flatMap((contents) =>
          fileSystem.writeFileString(
            verificationPath,
            `${contents.trimEnd()}\n- Verified: ${verifiedAt}\n`,
            { mode: 0o600 }
          )
        ),
        Effect.mapError(
          ioError(`Could not persist verification for ${manifest.recordingId}`)
        )
      );
    };

    const reject = (input: TeachingRecordingMutation) =>
      mutate(input.recordingId, "reject", input.operationId, (manifest) => {
        const { lifecycle } = manifest;
        return lifecycle._tag === "dry-run-passed"
          ? Effect.succeed({
              ...manifest,
              lifecycle: {
                _tag: "skill-drafted" as const,
                draftedAt: lifecycle.draftedAt,
                readyAt: lifecycle.readyAt,
                skillPath: lifecycle.skillPath,
                startedAt: lifecycle.startedAt,
                stoppedAt: lifecycle.stoppedAt,
              },
            })
          : Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot reject a Flow Skill from ${lifecycle._tag}.`
              )
            );
      });

    const cleanup = (input: TeachingRecordingMutation) => {
      const replay = purged.get(input.recordingId);
      if (
        replay !== undefined &&
        hasReceipt(replay, "cleanup", input.operationId)
      ) {
        return Effect.succeed(replay);
      }
      return withRecordingLock(
        input.recordingId,
        Effect.gen(function* cleanRecording() {
          const manifest = yield* readAt(
            input.recordingId,
            rootFor(input.recordingId)
          );
          if (
            manifest.lifecycle._tag !== "verified" ||
            (manifest.cleanup._tag !== "purge-pending" &&
              manifest.cleanup._tag !== "purged")
          ) {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} is not awaiting cleanup.`
              )
            );
          }
          const { lifecycle } = manifest;
          const directory = recordingDirectory(input.recordingId);
          const names = yield* fileSystem
            .readDirectory(directory)
            .pipe(
              Effect.mapError(
                ioError(
                  `Could not inspect retained files for ${input.recordingId}`
                )
              )
            );
          const sensitiveNames = names.filter(
            (name) => name !== MANIFEST_FILE && name !== LOCK_FILE
          );
          for (const name of sensitiveNames) {
            const removed = yield* Effect.result(
              fileSystem.remove(path.join(directory, name), {
                force: true,
                recursive: true,
              })
            );
            if (Result.isFailure(removed)) {
              const retainedFiles = yield* fileSystem
                .readDirectory(directory)
                .pipe(
                  Effect.map((entries) =>
                    entries.filter(
                      (entry) => entry !== MANIFEST_FILE && entry !== LOCK_FILE
                    )
                  ),
                  Effect.orElseSucceed(() => [name])
                );
              return yield* persist({
                ...manifest,
                cleanup: {
                  _tag: "purge-pending" as const,
                  failure: `Could not delete ${name}: ${removed.failure.message}`,
                  retainedFiles,
                },
                lifecycle,
                updatedAt: now().toISOString(),
              });
            }
          }
          const at = now().toISOString();
          const completed = withReceipt(
            {
              ...manifest,
              cleanup: { _tag: "purged" as const, completedAt: at },
              lifecycle,
            },
            "cleanup",
            input.operationId,
            at
          );
          yield* persist(completed);
          yield* fileSystem
            .remove(directory, { force: true, recursive: true })
            .pipe(
              Effect.mapError(
                ioError(
                  `Could not remove the directory for ${input.recordingId}`
                )
              )
            );
          purged.set(input.recordingId, completed);
          return completed;
        })
      );
    };

    const rename = (input: TeachingRecordingRename) =>
      mutate(input.recordingId, "rename", input.operationId, (manifest) =>
        manifest.lifecycle._tag === "setup"
          ? Effect.succeed({
              ...manifest,
              flowSkillName: input.flowSkillName,
            })
          : Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot be renamed from ${manifest.lifecycle._tag}.`
              )
            )
      );

    const discard = (input: TeachingRecordingMutation) =>
      mutate(input.recordingId, "discard", input.operationId, (manifest, at) =>
        Effect.gen(function* discardRecording() {
          if (
            manifest.lifecycle._tag !== "ready" &&
            manifest.lifecycle._tag !== "failed"
          ) {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot be discarded from ${manifest.lifecycle._tag}.`
              )
            );
          }
          const directory = recordingDirectory(input.recordingId);
          for (const artifact of manifest.artifacts) {
            yield* fileSystem
              .remove(path.resolve(directory, artifact.path), { force: true })
              .pipe(
                Effect.mapError(
                  ioError(`Could not discard Teaching artifact ${artifact.id}`)
                )
              );
          }
          return {
            ...manifest,
            artifacts: [],
            lifecycle: { _tag: "setup" as const, requestedAt: at },
          };
        })
      );

    const verify = (input: TeachingRecordingMutation) => {
      const replay = purged.get(input.recordingId);
      if (
        replay !== undefined &&
        hasReceipt(replay, "verification", input.operationId)
      ) {
        return Effect.succeed(replay);
      }
      return mutate(
        input.recordingId,
        "verification",
        input.operationId,
        (manifest, at) => {
          if (manifest.lifecycle._tag === "verified") {
            return Effect.succeed(manifest);
          }
          if (manifest.lifecycle._tag !== "dry-run-passed") {
            return Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot be verified from ${manifest.lifecycle._tag}.`
              )
            );
          }
          return markVerificationReference(manifest, at).pipe(
            Effect.as({
              ...manifest,
              cleanup: {
                _tag: "purge-pending" as const,
                failure: null,
                retainedFiles: manifest.artifacts.map(
                  (artifact) => artifact.path
                ),
              },
              lifecycle: {
                ...manifest.lifecycle,
                _tag: "verified" as const,
                verifiedAt: at,
              },
            })
          );
        }
      );
    };

    const listReady = () =>
      Effect.gen(function* listReadyRecordings() {
        const root = options.root();
        const directory = recordingsDirectory(root);
        const exists = yield* fileSystem
          .exists(directory)
          .pipe(
            Effect.mapError(ioError("Could not inspect Teaching Recordings"))
          );
        if (!exists) {
          return [];
        }
        const entries = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError(ioError("Could not list Teaching Recordings")));
        const recordingIds = entries.flatMap((entry) => {
          const decoded = Schema.decodeUnknownOption(RecordingIdSchema)(entry);
          return Option.isSome(decoded) ? [decoded.value] : [];
        });
        const manifests = yield* Effect.all(
          recordingIds.map((recordingId) =>
            readAndRecoverAt(recordingId, root)
          ),
          { concurrency: 1 }
        );
        return manifests.filter(
          (manifest) =>
            manifest.lifecycle._tag === "recording" ||
            manifest.lifecycle._tag === "ready" ||
            manifest.lifecycle._tag === "learning" ||
            manifest.lifecycle._tag === "skill-drafted" ||
            manifest.lifecycle._tag === "dry-running" ||
            manifest.lifecycle._tag === "dry-run-failed" ||
            manifest.lifecycle._tag === "dry-run-passed" ||
            manifest.lifecycle._tag === "verified" ||
            (manifest.lifecycle._tag === "failed" &&
              manifest.lifecycle.readyAt !== undefined)
        );
      });

    // Verification is persisted before purge-pending. If the process exited
    // between those writes, finish the durable transition before cleanup.
    yield* listReady().pipe(
      Effect.flatMap((manifests) =>
        Effect.forEach(
          manifests.filter(
            (manifest) => manifest.lifecycle._tag === "dry-run-passed"
          ),
          (manifest) => {
            if (manifest.lifecycle._tag !== "dry-run-passed") {
              return Effect.void;
            }
            const verificationPath = path.join(
              path.dirname(
                path.join(
                  rootFor(manifest.recordingId),
                  manifest.lifecycle.skillPath
                )
              ),
              VERIFICATION_FILE
            );
            return fileSystem.readFileString(verificationPath).pipe(
              Effect.flatMap((contents) =>
                VERIFIED_REFERENCE_PATTERN.test(contents)
                  ? verify({
                      operationId: OperationId.make(
                        `verification-recovery-${manifest.recordingId}`
                      ),
                      recordingId: manifest.recordingId,
                    })
                  : Effect.void
              ),
              Effect.ignore
            );
          },
          { discard: true }
        )
      ),
      Effect.ignore
    );
    // Cleanup recovery is best-effort during startup. The manifest remains
    // purge-pending with the retained file names when a retry still fails.
    yield* listReady().pipe(
      Effect.flatMap((manifests) =>
        Effect.forEach(
          manifests.filter(
            (manifest) =>
              manifest.cleanup._tag === "purge-pending" ||
              manifest.cleanup._tag === "purged"
          ),
          (manifest) =>
            cleanup({
              operationId: OperationId.make(
                `cleanup-recovery-${manifest.recordingId}`
              ),
              recordingId: manifest.recordingId,
            }).pipe(Effect.ignore),
          { discard: true }
        )
      ),
      Effect.ignore
    );

    return TeachingRecordingStore.of({
      begin,
      cleanup,
      directory: recordingDirectory,
      discard,
      failDryRun,
      failLearning,
      listReady,
      passDryRun,
      read,
      readClaimed,
      reject,
      releaseLearning,
      rename,
      saveSkill,
      start,
      startDryRun,
      startLearning,
      stop,
      verify,
    });
  }
);

export const makeTeachingRecordingStoreLayer = (
  options: TeachingRecordingStoreOptions
): Layer.Layer<TeachingRecordingStoreService, never, FileSystem.FileSystem> =>
  Layer.effect(TeachingRecordingStore, makeTeachingRecordingStore(options));
