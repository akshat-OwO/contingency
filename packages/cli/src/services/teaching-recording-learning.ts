import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  BrowserDevtoolsCommand,
  TEACHING_TIMELINE_BUDGET_CHARACTERS,
  TEACHING_TIMELINE_MAX_EVENTS,
  TeachingEvent,
} from "@contingency/protocol";
import type {
  FlowDiagnostic,
  FlowFile,
  FlowSaveResult,
  OperationId,
  TeachingKeyframeFile,
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

import { validateTaughtBrowserChecks } from "./browser-check-requirements.ts";
import { webHost } from "./domain-scope.ts";
import {
  discoverFlows,
  maintainCatalogGitignore,
  RESERVED_FLOW_NAMES,
} from "./flow-catalog-layout.ts";
import { isFlowDocument, isFlowDocumentArea } from "./flow-documents.ts";
import {
  FLOW_FILE,
  stampFlowProvenance,
  validateFlowPackage,
} from "./flow-package.ts";
import {
  parameterizeBrowserCommand,
  stampBrowserState,
} from "./saved-browser-state.ts";
import { validateTaughtScans } from "./scan-requirements.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { teachingRecordingSummary } from "./teaching-recording-orchestration.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";
import type { TeachingRecordingStoreError } from "./teaching-recording-store.ts";

const EVENTS_FILE_KIND = "events";

/** Shorter values match ordinary prose too often to rewrite safely. */
const MIN_PARAMETERIZED_LENGTH = 4;

/** A reusable flow stores the declared Variable reference, never its example value. */
export const parameterizeVariables = (
  files: readonly FlowFile[],
  events: readonly TeachingEvent[]
): readonly FlowFile[] => {
  const values = events
    .flatMap((event) =>
      event._tag === "action" &&
      event.variableName !== undefined &&
      event.target?.value !== undefined &&
      event.target.value !== null &&
      event.target.value.length >= MIN_PARAMETERIZED_LENGTH
        ? [{ name: event.variableName, value: event.target.value }]
        : []
    )
    .toSorted((left, right) => right.value.length - left.value.length);
  if (values.length === 0) {
    return files;
  }
  const names = new Map(values.map(({ name, value }) => [value, name]));
  const literals = [...names.keys()].map((value) =>
    value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  );
  // One pass preserves existing references and cannot rewrite a reference it just inserted.
  // Whole tokens only, so a value inside a longer word is left alone.
  const pattern = new RegExp(
    `\\{\\{[^{}]+\\}\\}|(?<![\\p{L}\\p{N}_])(?:${literals.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu"
  );
  return files.map((file) => {
    if (file.path !== FLOW_FILE && !file.path.endsWith(".md")) {
      return file;
    }
    const prefix =
      file.path === FLOW_FILE
        ? (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(file.content)?.[0] ?? "")
        : "";
    const body = file.content.slice(prefix.length).replace(pattern, (match) => {
      if (match.startsWith("{{")) {
        return match;
      }
      const name = names.get(match);
      return name === undefined ? match : `{{${name}}}`;
    });
    return { ...file, content: prefix + body };
  });
};
const FLOW_LOCK_FILE = ".flow.lock";

interface TeachingRecordingLearningDomainError {
  readonly _tag: "TeachingRecordingLearningError";
  readonly code:
    | "teaching_recording_conflict"
    | "teaching_recording_invalid"
    | "teaching_recording_io"
    | "teaching_recording_not_found"
    | "teaching_recording_timeout"
    | "teaching_recording_unclaimed"
    | "teaching_timeline_too_large";
  readonly diagnostics: readonly FlowDiagnostic[];
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
  diagnostics: readonly FlowDiagnostic[]
): TeachingRecordingLearningError => ({
  _tag: "TeachingRecordingLearningError",
  code: "teaching_recording_invalid",
  diagnostics,
  message: `The Flow package was not saved: ${diagnostics
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

const isSafeFlowPath = (filePath: string): boolean =>
  isFlowDocumentArea(filePath) &&
  (filePath === FLOW_FILE || !filePath.split("/").includes(FLOW_FILE));

const pathDiagnostic = (
  code: string,
  message: string,
  filePath: string
): FlowDiagnostic => ({ code, message, path: [filePath] });

const validateFiles = (
  files: readonly FlowFile[]
): Effect.Effect<readonly FlowFile[], TeachingRecordingLearningError> => {
  const missingFlowFile = pathDiagnostic(
    "flow_missing_flow_file",
    "A Flow package must contain flow.md.",
    FLOW_FILE
  );
  if (files.length === 0) {
    return Effect.fail(invalidPackage([missingFlowFile]));
  }
  const names = new Set<string>();
  const documents: FlowFile[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".md") && !isFlowDocument(file.path)) {
      continue;
    }
    if (!isSafeFlowPath(file.path)) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_unsafe_path",
            `Flow file ${file.path} must stay in the Flow document area, outside runs/ and recordings/.`,
            file.path
          ),
        ])
      );
    }
    documents.push(file);
    if (file.content.trim().length === 0) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_empty_file",
            `Flow file ${file.path} must not be empty.`,
            file.path
          ),
        ])
      );
    }
    if (names.has(file.path)) {
      return Effect.fail(
        invalidPackage([
          pathDiagnostic(
            "flow_duplicate_file",
            `Flow file ${file.path} appears more than once.`,
            file.path
          ),
        ])
      );
    }
    names.add(file.path);
  }
  return names.has(FLOW_FILE)
    ? Effect.succeed(documents)
    : Effect.fail(invalidPackage([missingFlowFile]));
};

/** Project the durable events into bounded Timeline pages. */
const eventProjection = (
  event: TeachingEvent,
  manifest: TeachingRecordingManifest
): Effect.Effect<TeachingTimelineEntry, TeachingRecordingLearningError> => {
  switch (event._tag) {
    case "browser-modification": {
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(BrowserDevtoolsCommand)
      )(event.command).pipe(
        Effect.map((command) => ({
          ...event,
          command: JSON.stringify(
            parameterizeBrowserCommand(command, (value, hint) =>
              value.startsWith("{{")
                ? value
                : `{{${event.variableNames?.[hint] ?? hint.toUpperCase().replaceAll(/[^A-Z0-9_]+/gu, "_")}}}`
            )
          ),
          description: "Apply saved browser state",
          valueDigests: [],
          variableNames: {},
        })),
        Effect.mapError(() =>
          learningError("teaching_recording_invalid", "Invalid browser state")
        )
      );
    }
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
        target: event.target,
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
      if (artifact === undefined) {
        return Effect.fail(
          learningError(
            "teaching_recording_invalid",
            `Teaching Recording ${manifest.recordingId} references an unknown keyframe.`
          )
        );
      }
      const frame = {
        _tag: "keyframe" as const,
        actionId: event.actionId,
        at: event.at,
        hash: event.hash,
        id: artifact.id,
        seq: event.seq,
      };
      const captured =
        event.capture === undefined
          ? frame
          : { ...frame, capture: event.capture };
      return Effect.succeed(
        event.url === undefined
          ? captured
          : { ...captured, url: sanitizeTeachingUrl(event.url) }
      );
    }
    default: {
      return Effect.succeed(event);
    }
  }
};

export interface SaveFlowInput {
  readonly claimOperationId: OperationId;
  readonly files: readonly FlowFile[];
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
  ) => Effect.Effect<TeachingKeyframeFile, TeachingRecordingLearningError>;
  readonly list: () => Effect.Effect<
    readonly TeachingRecordingSummary[],
    TeachingRecordingLearningError
  >;
  readonly save: (
    input: SaveFlowInput
  ) => Effect.Effect<FlowSaveResult, TeachingRecordingLearningError>;
  readonly timeline: (
    input: TeachingTimelineInput
  ) => Effect.Effect<TeachingTimeline, TeachingRecordingLearningError>;
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
          const summary = teachingRecordingSummary(manifest);
          return summary === undefined ? [] : [summary];
        })
      ),
      Effect.mapError(fromStoreError)
    );

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
      const file = path.resolve(store.directory(recordingId), artifact.path);
      const info = yield* fileSystem
        .stat(file)
        .pipe(
          Effect.mapError(
            ioError(`Could not stat keyframe ${keyframeId} from ${recordingId}`)
          )
        );
      if (info.type !== "File" || info.size <= 0n) {
        return yield* Effect.fail(
          learningError(
            "teaching_recording_invalid",
            `Teaching Recording ${recordingId} has no readable keyframe ${keyframeId}.`
          )
        );
      }
      return {
        bytes: Number(info.size),
        format: "png",
        hash: artifact.hash,
        id: artifact.id,
        path: file,
        recordingId,
      } satisfies TeachingKeyframeFile;
    });

  const withFlowLock = <A>(
    catalogRoot: string,
    operation: Effect.Effect<A, TeachingRecordingLearningError>
  ): Effect.Effect<A, TeachingRecordingLearningError> => {
    const lockPath = path.join(catalogRoot, FLOW_LOCK_FILE);
    const conflict = learningError(
      "teaching_recording_conflict",
      "Another process is saving a Flow in this Catalog Root."
    );
    const create = fileSystem
      .writeFileString(lockPath, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(Effect.mapError(() => conflict));
    return Effect.gen(function* lockFlowCatalog() {
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

  const save = (input: SaveFlowInput) =>
    Effect.gen(function* saveFlowPackage() {
      const files = yield* validateFiles(input.files);
      const existing = yield* store
        .read(input.recordingId)
        .pipe(Effect.mapError(fromStoreError));
      const replay = existing.receipts.find(
        (receipt) =>
          receipt.operation === "save-flow" &&
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
          flowName: existing.flowName,
          recordingId: existing.recordingId,
        } satisfies FlowSaveResult;
      }
      const manifest = yield* store
        .readClaimed(input.recordingId, input.claimOperationId)
        .pipe(Effect.mapError(fromStoreError));
      const events = yield* readEvents(manifest);
      const learnedFiles = yield* stampBrowserState(
        parameterizeVariables(files, events),
        events
      ).pipe(
        Effect.mapError((error) =>
          learningError("teaching_recording_invalid", error.message)
        )
      );
      // The package contract is checked here, in the same pre-write window as
      // the path rules: an invalid package must never become the live
      // directory, so nothing is staged until every property holds.
      const validated = validateFlowPackage(manifest.flowName, learnedFiles);
      if (Result.isFailure(validated)) {
        return yield* Effect.fail(invalidPackage(validated.failure));
      }
      // A verified Flow outlives its recording, so the demonstrated host
      // ceiling and device are stamped into the package now, while the event
      // stream is still on disk to prove them.
      yield* validateTaughtBrowserChecks(
        learnedFiles,
        events.filter((event) => event._tag === "instruction")
      ).pipe(
        Effect.mapError((cause) =>
          learningError("teaching_recording_invalid", cause.message)
        )
      );
      yield* validateTaughtScans(
        learnedFiles,
        events.filter((event) => event._tag === "instruction")
      ).pipe(
        Effect.mapError((cause) =>
          learningError("teaching_recording_invalid", cause.message)
        )
      );
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
      // Guided Runs grant exact hosts explicitly. A host approved but never
      // reached still belongs to their scope; visited pages cannot enlarge it.
      // Older recordings retain the original visited-host derivation.
      const demonstratedHosts =
        manifest.origin === "guided-run" && manifest.approvedHosts !== undefined
          ? [...new Set(manifest.approvedHosts)].toSorted()
          : [...visited].toSorted();
      const stamped = learnedFiles.map((file) =>
        file.path === FLOW_FILE
          ? {
              ...file,
              content: stampFlowProvenance(file.content, {
                emulation:
                  manifest.emulation === null
                    ? null
                    : {
                        colorScheme:
                          manifest.emulation.colorScheme ?? undefined,
                        // A fixed position and the permissions the site was answered
                        // with are part of what the journey needs, so they are
                        // stamped beside the device rather than left implicit (#241).
                        geolocation:
                          manifest.emulation.geolocation === undefined ||
                          manifest.emulation.geolocation === null
                            ? undefined
                            : {
                                accuracy:
                                  manifest.emulation.geolocation.accuracy ??
                                  undefined,
                                latitude:
                                  manifest.emulation.geolocation.latitude,
                                longitude:
                                  manifest.emulation.geolocation.longitude,
                              },
                        locale: manifest.emulation.locale ?? undefined,
                        pageZoom: manifest.emulation.pageZoom ?? 100,
                        permissions: manifest.emulation.permissions.map(
                          (decision) => ({
                            origin: decision.origin ?? undefined,
                            permission: decision.permission,
                            state: decision.state,
                          })
                        ),
                        textScale: manifest.emulation.textScale ?? 100,
                        timezone: manifest.emulation.timezoneId ?? undefined,
                        userAgentProfile: manifest.emulation.userAgentProfile,
                        viewport: manifest.emulation.viewport,
                      },
                hosts: demonstratedHosts,
                runtime: manifest.runtime,
              }),
            }
          : file
      );
      const recordingDirectory = store.directory(input.recordingId);
      const catalogRoot = store.catalogRoot(input.recordingId);
      return yield* withFlowLock(
        catalogRoot,
        Effect.gen(function* replaceFlowAtomically() {
          const target = path.dirname(path.dirname(recordingDirectory));
          if (RESERVED_FLOW_NAMES.has(manifest.flowName)) {
            return yield* Effect.fail(
              learningError(
                "teaching_recording_invalid",
                `Reserved Flow name at ${target}.`
              )
            );
          }
          const flows = yield* discoverFlows(catalogRoot, fileSystem).pipe(
            Effect.mapError((cause) =>
              learningError("teaching_recording_invalid", cause.message)
            )
          );
          const collision = flows.get(manifest.flowName);
          if (collision !== undefined && collision.directory !== target) {
            return yield* Effect.fail(
              learningError(
                "teaching_recording_conflict",
                `Duplicate Flow name "${manifest.flowName}" at ${collision.directory} and ${target}.`
              )
            );
          }
          if (
            collision === undefined &&
            (yield* fileSystem
              .exists(target)
              .pipe(Effect.mapError(ioError(`Could not inspect ${target}`))))
          ) {
            return yield* Effect.fail(
              learningError(
                "teaching_recording_conflict",
                `${target} is an existing Group, not a Flow.`
              )
            );
          }
          yield* maintainCatalogGitignore(catalogRoot, fileSystem).pipe(
            Effect.mapError(ioError("Could not maintain catalog ignores"))
          );
          // Stage documents only. Evidence writers do not take the catalog lock,
          // so the Flow directory and its evidence must remain in place.
          const temporary = path.join(catalogRoot, `.flow-${randomUUID()}.tmp`);
          yield* fileSystem
            .makeDirectory(temporary, { mode: 0o700 })
            .pipe(Effect.mapError(ioError("Could not stage Flow documents")));
          const install = Effect.gen(function* installDocuments() {
            const previous = new Map<string, Uint8Array>();
            const realTarget = yield* fileSystem.realPath(target);
            const requireInside = Effect.fnUntraced(function* requireInside(
              file: string
            ) {
              const real = yield* fileSystem.realPath(file);
              const relative = path.relative(realTarget, real);
              if (
                relative.startsWith("..") ||
                path.isAbsolute(relative) ||
                (relative !== "" &&
                  !isFlowDocumentArea(relative.split(path.sep).join("/")))
              ) {
                return yield* Effect.fail(
                  learningError(
                    "teaching_recording_invalid",
                    `Flow document is outside its document directories: ${file}`
                  )
                );
              }
            });
            const pending = [""];
            const visitedDirectories = new Set<string>();
            while (pending.length > 0) {
              const directory = pending.pop() ?? "";
              const real = yield* fileSystem.realPath(
                path.join(target, directory)
              );
              if (visitedDirectories.has(real)) {
                continue;
              }
              visitedDirectories.add(real);
              for (const name of yield* fileSystem.readDirectory(
                path.join(target, directory)
              )) {
                const relative = path.join(directory, name);
                if (!isSafeFlowPath(relative.split(path.sep).join("/"))) {
                  continue;
                }
                const file = path.join(target, relative);
                const info = yield* fileSystem.stat(file);
                if (info.type === "Directory") {
                  yield* requireInside(file);
                  pending.push(relative);
                } else if (
                  info.type === "File" &&
                  isFlowDocument(relative.split(path.sep).join("/"))
                ) {
                  yield* requireInside(file);
                  previous.set(relative, yield* fileSystem.readFile(file));
                }
              }
            }
            for (const file of stamped) {
              const destination = path.join(temporary, file.path);
              yield* fileSystem.makeDirectory(path.dirname(destination), {
                recursive: true,
              });
              yield* fileSystem.writeFileString(destination, file.content, {
                mode: 0o600,
              });
            }
            const changed: string[] = [];
            const installed = yield* Effect.result(
              Effect.gen(function* commitDocuments() {
                for (const file of stamped) {
                  const destination = path.join(target, file.path);
                  let parent = path.dirname(destination);
                  while (!(yield* fileSystem.exists(parent))) {
                    parent = path.dirname(parent);
                  }
                  yield* requireInside(parent);
                  yield* fileSystem.makeDirectory(path.dirname(destination), {
                    recursive: true,
                  });
                  yield* requireInside(path.dirname(destination));
                  yield* fileSystem.rename(
                    path.join(temporary, file.path),
                    destination
                  );
                  changed.push(file.path);
                }
                const incoming = new Set(stamped.map((file) => file.path));
                for (const relative of previous.keys()) {
                  if (!incoming.has(relative)) {
                    yield* fileSystem.remove(path.join(target, relative));
                    changed.push(relative);
                  }
                }
                return yield* store
                  .saveFlow({
                    claimOperationId: input.claimOperationId,
                    files: stamped.map((file) => file.path),
                    operationId: input.operationId,
                    recordingId: input.recordingId,
                  })
                  .pipe(Effect.mapError(fromStoreError));
              }).pipe(
                Effect.mapError((cause) =>
                  cause._tag === "TeachingRecordingLearningError"
                    ? cause
                    : ioError("Could not install Flow documents")(cause)
                )
              )
            );
            if (Result.isFailure(installed)) {
              for (const relative of changed.toReversed()) {
                const destination = path.join(target, relative);
                const bytes = previous.get(relative);
                if (bytes === undefined) {
                  yield* fileSystem.remove(destination, { force: true });
                } else {
                  const restore = path.join(temporary, "restore");
                  yield* fileSystem.writeFile(restore, bytes, { mode: 0o600 });
                  yield* fileSystem.rename(restore, destination);
                }
              }
              return yield* Effect.fail(installed.failure);
            }
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "TeachingRecordingLearningError"
                ? cause
                : ioError("Could not replace Flow documents")(cause)
            ),
            Effect.ensuring(
              fileSystem
                .remove(temporary, { force: true, recursive: true })
                .pipe(Effect.ignore)
            ),
            Effect.uninterruptible
          );
          yield* install;
          return {
            files: stamped.map((file) => file.path),
            flowName: manifest.flowName,
            recordingId: manifest.recordingId,
          } satisfies FlowSaveResult;
        })
      );
    });

  return TeachingRecordingLearning.of({ keyframe, list, save, timeline });
});

export const TeachingRecordingLearningLive = Layer.effect(
  TeachingRecordingLearning,
  makeTeachingRecordingLearning()
);
