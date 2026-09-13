import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentSessionId,
  DraftEmulation,
  FlowSkillName,
  OperationId,
  TeachingRecordingArtifact,
  TeachingRecordingId,
  TeachingRecordingManifest,
  TeachingRecordingOperation,
} from "@contingency/protocol";
import {
  TeachingRecordingId as RecordingIdSchema,
  TeachingRecordingManifest as ManifestSchema,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

export const TEACHING_RECORDINGS_DIRECTORY = ".recordings";
const MANIFEST_FILE = "manifest.json";

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

export interface TeachingRecordingStop extends TeachingRecordingMutation {
  readonly artifacts: readonly TeachingRecordingArtifact[];
}

export interface TeachingRecordingSkillDraft extends TeachingRecordingMutation {
  readonly skillPath: string;
}

export interface TeachingRecordingStoreService {
  readonly begin: (
    input: TeachingRecordingBegin
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly cleanup: (
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
  readonly start: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly stop: (
    input: TeachingRecordingStop
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly startDryRun: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly startLearning: (
    input: TeachingRecordingMutation
  ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>;
  readonly passDryRun: (
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
  completedAt: string
): TeachingRecordingManifest => ({
  ...manifest,
  receipts: [...manifest.receipts, { completedAt, operation, operationId }],
  updatedAt: completedAt,
});

const makeTeachingRecordingStore = Effect.fn("TeachingRecordingStore.make")(
  function* makeStore(options: TeachingRecordingStoreOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const now = options.now ?? (() => new Date());
    const locks = new Map<TeachingRecordingId, Semaphore.Semaphore>();
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

    const read = (recordingId: TeachingRecordingId) =>
      readAt(recordingId, rootFor(recordingId));

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

    const mutate = (
      recordingId: TeachingRecordingId,
      operation: TeachingRecordingOperation,
      operationId: OperationId,
      transition: (
        manifest: PendingTeachingRecordingManifest,
        at: string
      ) => Effect.Effect<TeachingRecordingManifest, TeachingRecordingStoreError>
    ) =>
      lockFor(recordingId).withPermit(
        Effect.gen(function* mutateManifest() {
          const current = yield* read(recordingId);
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
            withReceipt(transitioned, operation, operationId, at)
          );
        })
      );

    const begin = (input: TeachingRecordingBegin) =>
      lockFor(input.recordingId).withPermit(
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
            const existing = yield* read(input.recordingId);
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
        })
      );

    const start = (input: TeachingRecordingMutation) =>
      lockFor(input.recordingId).withPermit(
        Effect.gen(function* startRecording() {
          const current = yield* read(input.recordingId);
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
      lockFor(input.recordingId).withPermit(
        Effect.gen(function* stopRecording() {
          const current = yield* read(input.recordingId);
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
          const ready = yield* validateArtifactPaths({
            ...current,
            artifacts: input.artifacts,
            lifecycle: {
              _tag: "ready",
              readyAt,
              startedAt,
              stoppedAt,
            },
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
        (manifest) =>
          manifest.lifecycle._tag === "ready"
            ? Effect.succeed({
                ...manifest,
                lifecycle: { ...manifest.lifecycle, _tag: "learning" },
              })
            : Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot start learning from ${manifest.lifecycle._tag}.`
                )
              )
      );

    const saveSkill = (input: TeachingRecordingSkillDraft) =>
      mutate(
        input.recordingId,
        "save-skill",
        input.operationId,
        (manifest, at) =>
          manifest.lifecycle._tag === "learning"
            ? Effect.succeed({
                ...manifest,
                lifecycle: {
                  ...manifest.lifecycle,
                  _tag: "skill-drafted",
                  draftedAt: at,
                  skillPath: input.skillPath,
                },
              })
            : Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot save a Flow Skill from ${manifest.lifecycle._tag}.`
                )
              )
      );

    const startDryRun = (input: TeachingRecordingMutation) =>
      mutate(
        input.recordingId,
        "start-dry-run",
        input.operationId,
        (manifest, at) =>
          manifest.lifecycle._tag === "skill-drafted"
            ? Effect.succeed({
                ...manifest,
                lifecycle: {
                  ...manifest.lifecycle,
                  _tag: "dry-running",
                  dryRunStartedAt: at,
                },
              })
            : Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot start a Dry Run from ${manifest.lifecycle._tag}.`
                )
              )
      );

    const passDryRun = (input: TeachingRecordingMutation) =>
      mutate(
        input.recordingId,
        "pass-dry-run",
        input.operationId,
        (manifest, at) =>
          manifest.lifecycle._tag === "dry-running"
            ? Effect.succeed({
                ...manifest,
                lifecycle: {
                  ...manifest.lifecycle,
                  _tag: "dry-run-passed",
                  dryRunEndedAt: at,
                },
              })
            : Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot pass a Dry Run from ${manifest.lifecycle._tag}.`
                )
              )
      );

    const cleanup = (input: TeachingRecordingMutation) =>
      mutate(input.recordingId, "cleanup", input.operationId, (manifest, at) =>
        Effect.gen(function* cleanRecording() {
          const { lifecycle } = manifest;
          if (lifecycle._tag !== "verified") {
            return yield* Effect.fail(
              storeError(
                "teaching_recording_conflict",
                `Teaching Recording ${input.recordingId} cannot clean up from ${manifest.lifecycle._tag}.`
              )
            );
          }
          const directory = recordingDirectory(input.recordingId);
          for (const artifact of manifest.artifacts) {
            yield* fileSystem
              .remove(path.resolve(directory, artifact.path), { force: true })
              .pipe(
                Effect.mapError(
                  ioError(`Could not clean Teaching artifact ${artifact.id}`)
                )
              );
          }
          return {
            ...manifest,
            cleanup: { _tag: "completed", completedAt: at },
            lifecycle,
          };
        })
      );

    const verify = (input: TeachingRecordingMutation) =>
      mutate(
        input.recordingId,
        "verification",
        input.operationId,
        (manifest, at) => {
          if (manifest.lifecycle._tag === "verified") {
            return Effect.succeed(manifest);
          }
          return manifest.lifecycle._tag === "dry-run-passed"
            ? Effect.succeed({
                ...manifest,
                lifecycle: {
                  ...manifest.lifecycle,
                  _tag: "verified",
                  verifiedAt: at,
                },
              })
            : Effect.fail(
                storeError(
                  "teaching_recording_conflict",
                  `Teaching Recording ${input.recordingId} cannot be verified from ${manifest.lifecycle._tag}.`
                )
              );
        }
      );

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
          recordingIds.map((recordingId) => readAt(recordingId, root))
        );
        return manifests.filter(
          (manifest) => manifest.lifecycle._tag === "ready"
        );
      });

    return TeachingRecordingStore.of({
      begin,
      cleanup,
      directory: recordingDirectory,
      listReady,
      passDryRun,
      read,
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
