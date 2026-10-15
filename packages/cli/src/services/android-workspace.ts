import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  OperationId,
  TeachingRecordingId,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  TeachingEvent,
  TeachingRecordingArtifact,
  PlatformRequirements,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AndroidRun, AndroidRunInput } from "./android-run-contract.ts";
import { androidHelperRelease } from "./android-runtime-contract.ts";
import type { AndroidObservation } from "./android-runtime-contract.ts";
import { acquireAndroidStream } from "./android-stream.ts";
import type { AndroidDeviceStream } from "./android-stream.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { PlatformRuntimeFactory } from "./platform-runtime.ts";
import { decideFlowSkill } from "./teaching-recording-orchestration.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";

export interface AndroidWorkspaceError {
  readonly code: string;
  readonly message: string;
}
const error = (code: string, message: string): AndroidWorkspaceError => ({
  code,
  message,
});
const denied = (message: string) =>
  Effect.fail(error("android_workspace_refused", message));
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const observationSummary = (observation: AndroidObservation) => ({
  android: {
    nodes: observation.nodes.flatMap((node) =>
      node.password ? [] : [{ name: node.name, role: node.role }]
    ),
    observationId: observation.id,
    screenshotCapturedAt: observation.screenshot.capturedAt,
  },
  nodeCount: observation.nodes.length,
  title: observation.ownership.focusedPackage,
  url: "",
});
const difference = (left: AndroidObservation, right: AndroidObservation) =>
  left.nodes.flatMap((node) =>
    node.password ||
    right.nodes.some(
      (other) => other.role === node.role && other.name === node.name
    )
      ? []
      : [{ name: node.name, role: node.role }]
  );
const visible = (
  observation: AndroidObservation,
  condition: { readonly role: string; readonly name: string }
) =>
  observation.nodes.some(
    (node) =>
      node.role === condition.role &&
      node.name === condition.name &&
      !node.password &&
      !node.covered &&
      node.packageName === observation.ownership.focusedPackage
  );
const supportsWorkspaceRequirements = (
  requirements: PlatformRequirements,
  inputCount: number
) =>
  requirements.platform === "android" &&
  requirements.preparation !== undefined &&
  (requirements.outcomes?.length ?? 0) > 0 &&
  !requirements.capabilities.includes("private-input") &&
  inputCount === 0;
const semanticSignature = (nodes: AndroidObservation["nodes"]) =>
  JSON.stringify(
    nodes.map(({ role, name, editable, covered, password, packageName }) => ({
      covered,
      editable,
      name,
      packageName,
      password,
      role,
    }))
  );

interface SessionState {
  /** Bounded semantic selections only; historical frames never retain screenshot pixels. */
  readonly observations: readonly Pick<AndroidObservation, "id" | "nodes">[];
  readonly revision: number;
  readonly summary: AndroidWorkspaceSummary;
  readonly observation: AndroidObservation | null;
  readonly recording: boolean;
  readonly sequence: number;
  readonly artifacts: readonly TeachingRecordingArtifact[];
  readonly bytes: number;
}
interface Session {
  readonly stream: AndroidDeviceStream;
  readonly state: Atom.Writable<SessionState>;
  readonly run: AndroidRun;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly receipts: Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Result.Result<
        AndroidWorkspaceSnapshot,
        AndroidWorkspaceError
      >;
    }
  >;
  readonly directory: string;
  readonly summaryFile: string;
}
type EventPayload<E = TeachingEvent> = E extends TeachingEvent
  ? Omit<E, "seq" | "at">
  : never;
export interface AndroidWorkspaceService {
  readonly stream: (
    sessionId: AgentSessionId
  ) => Effect.Effect<AndroidDeviceStream | null>;
  readonly execute: (
    command: AndroidWorkspaceCommand,
    source: "agent" | "user"
  ) => Effect.Effect<AndroidWorkspaceSnapshot, AndroidWorkspaceError>;
  readonly list: () => Effect.Effect<
    readonly AndroidWorkspaceSummary[],
    AndroidWorkspaceError
  >;
}
export const AndroidWorkspace = Context.Service<AndroidWorkspaceService>(
  "@contingency/AndroidWorkspace"
);

/** Selected-device mirror and capture. There is no stock hub, raw input route, or automatic replay. */
export const makeAndroidWorkspaceLayer = (options: {
  readonly root: () => string;
}) =>
  Layer.effect(
    AndroidWorkspace,
    Effect.gen(function* makeWorkspace() {
      const fs = yield* FileSystem.FileSystem;
      const store = yield* TeachingRecordingStore;
      const catalog = yield* FlowSkillCatalog;
      const factory = yield* PlatformRuntimeFactory;
      const registry = AtomRegistry.make();
      const sessions = new Map<AgentSessionId, Session>();
      const startLock = Semaphore.makeUnsafe(1);
      const starts = new Map<
        string,
        { readonly fingerprint: string; readonly id: AgentSessionId }
      >();
      const io = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError(() =>
            error(
              "android_evidence_io",
              "Could not retain Android evidence. Input is paused; inspect local retained files."
            )
          )
        );
      const state = (session: Session) => registry.get(session.state);
      const update = (
        session: Session,
        change: (current: SessionState) => SessionState
      ) =>
        registry.update(session.state, (current) => ({
          ...change(current),
          revision: current.revision + 1,
        }));
      const persist = (session: Session) =>
        Effect.gen(function* persistSummary() {
          const summary = {
            ...state(session).summary,
            preparation: session.run.state(),
          };
          update(session, (current) => ({ ...current, summary }));
          yield* io(
            fs.makeDirectory(path.dirname(session.summaryFile), {
              recursive: true,
            })
          );
          const temporary = `${session.summaryFile}.tmp`;
          yield* io(
            fs.writeFileString(temporary, JSON.stringify(summary, null, 2), {
              mode: 0o600,
            })
          );
          yield* io(fs.rename(temporary, session.summaryFile));
        });
      const recordingState = (recordingId: TeachingRecordingId | null) =>
        recordingId === null
          ? Effect.succeed({ captureState: null, cleanup: null })
          : store.read(recordingId).pipe(
              Effect.map((manifest) => ({
                captureState: manifest.lifecycle,
                cleanup: manifest.cleanup,
              }))
            );
      const snapshot = (
        session: Session,
        image = false
      ): Effect.Effect<AndroidWorkspaceSnapshot, AndroidWorkspaceError> =>
        Effect.gen(function* snapshotWorkspace() {
          const current = state(session);
          const recording = yield* recordingState(current.summary.recordingId);
          const captured = current.observation;
          return {
            ...current.summary,
            ...recording,
            observation:
              captured === null
                ? null
                : {
                    capturedAt: captured.screenshot.capturedAt,
                    height: Buffer.from(
                      captured.screenshot.image,
                      "base64"
                    ).readUInt32BE(20),
                    id: captured.id,
                    image: image ? captured.screenshot.image : null,
                    nodes: captured.nodes.filter((node) => !node.password),
                    width: Buffer.from(
                      captured.screenshot.image,
                      "base64"
                    ).readUInt32BE(16),
                  },
            preparation: session.run.state(),
            revision: current.revision,
          } satisfies AndroidWorkspaceSnapshot;
        });
      const emit = (session: Session, event: EventPayload) =>
        Effect.gen(function* appendEvent() {
          const current = state(session);
          const encoded = `${JSON.stringify({ ...event, at: now(), seq: current.sequence })}\n`;
          if (
            current.bytes + Buffer.byteLength(encoded) > 64 * 1024 * 1024 ||
            current.sequence >= 10_000
          ) {
            return yield* Effect.fail(
              error(
                "capture_incomplete",
                "The Android capture limit was reached. Start a new complete recording."
              )
            );
          }
          yield* io(
            fs.writeFileString(
              path.join(session.directory, "events.jsonl"),
              encoded,
              { flag: "a", mode: 0o600 }
            )
          );
          update(session, (value) => ({
            ...value,
            bytes: value.bytes + Buffer.byteLength(encoded),
            sequence: value.sequence + 1,
          }));
        });
      const keyframe = (
        session: Session,
        observation: AndroidObservation,
        actionId: string | null
      ) =>
        Effect.gen(function* retainKeyframe() {
          const bytes = Buffer.from(observation.screenshot.image, "base64");
          const current = state(session);
          if (current.bytes + bytes.length > 64 * 1024 * 1024) {
            return yield* Effect.fail(
              error(
                "capture_incomplete",
                "The Android capture size limit was reached."
              )
            );
          }
          const digest = ContentHash.make(`sha256-${hash(bytes)}`);
          const relative = `keyframes/${digest}.png`;
          yield* io(
            fs.makeDirectory(path.join(session.directory, "keyframes"), {
              recursive: true,
            })
          );
          yield* io(
            fs.writeFile(path.join(session.directory, relative), bytes, {
              mode: 0o600,
            })
          );
          update(session, (value) => ({
            ...value,
            artifacts: [
              ...value.artifacts,
              {
                capturedAt: now(),
                hash: digest,
                id: observation.id,
                kind: "keyframe",
                path: relative,
              },
            ],
            bytes: value.bytes + bytes.length,
          }));
          yield* emit(session, {
            _tag: "keyframe",
            actionId,
            hash: digest,
            path: relative,
          });
        });
      const finishRecording = (
        session: Session,
        operationId: OperationId,
        failure?: string
      ) =>
        Effect.gen(function* stopRetainedSources() {
          const current = state(session);
          if (!current.recording || current.summary.recordingId === null) {
            return;
          }
          // Close the retention interval before any durable finalization can fail.
          update(session, (value) => ({ ...value, recording: false }));
          const emitted = yield* Effect.result(
            emit(session, {
              _tag: "stopped",
              detail: failure ?? null,
              reason: failure === undefined ? "user" : "capture-failed",
            })
          );
          const contents = yield* Effect.result(
            io(fs.readFile(path.join(session.directory, "events.jsonl")))
          );
          const eventArtifacts: TeachingRecordingArtifact[] = Result.isSuccess(
            contents
          )
            ? [
                {
                  capturedAt: now(),
                  hash: ContentHash.make(`sha256-${hash(contents.success)}`),
                  id: "android-events",
                  kind: "events",
                  path: "events.jsonl",
                },
              ]
            : [];
          yield* store.stop({
            artifacts: [...state(session).artifacts, ...eventArtifacts],
            failure:
              failure ??
              (Result.isFailure(contents) || Result.isFailure(emitted)
                ? "Capture finalization lost retained evidence."
                : undefined),
            operationId,
            recordingId: current.summary.recordingId,
          });
        });
      const pause = (session: Session, cause: AndroidWorkspaceError) =>
        Effect.gen(function* pauseInput() {
          update(session, (current) => ({
            ...current,
            observation: null,
            observations: [],
            summary: {
              ...current.summary,
              captureGaps: [...current.summary.captureGaps, cause.code],
              error: cause.message,
              phase: "paused",
            },
          }));
          yield* finishRecording(
            session,
            OperationId.make(`android-gap-${randomUUID()}`),
            cause.message
          );
          yield* persist(session);
        });
      const acceptObservation = (
        session: Session,
        observation: AndroidObservation
      ) => {
        update(session, (current) => ({
          ...current,
          observation,
          observations: [
            ...current.observations.slice(-7),
            { id: observation.id, nodes: observation.nodes },
          ],
          summary: { ...current.summary, error: null, phase: "running" },
        }));
      };
      const close = (session: Session) =>
        Effect.gen(function* closeWorkspace() {
          yield* finishRecording(
            session,
            OperationId.make(`android-close-${randomUUID()}`),
            "The session closed during capture."
          );
          const current = state(session).summary;
          if (current.kind === "dry-run" && current.recordingId !== null) {
            const manifest = yield* store.read(current.recordingId);
            if (manifest.lifecycle._tag === "dry-running") {
              yield* store.failDryRun({
                observableOutcome:
                  "The session closed before a complete passing assessment. Cancellation does not undo input.",
                operationId: OperationId.make(
                  `android-close-run-${randomUUID()}`
                ),
                recordingId: current.recordingId,
              });
            }
          }
          yield* session.run.close();
          yield* Scope.close(session.scope, Exit.void);
          update(session, (value) => ({
            ...value,
            observation: null,
            observations: [],
            summary: {
              ...value.summary,
              completedAt: value.summary.completedAt ?? now(),
              phase: "closed",
            },
          }));
          yield* persist(session);
        });
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...sessions.values()],
          (session) =>
            session.lock.withPermits(1)(close(session)).pipe(Effect.ignore),
          { discard: true }
        ).pipe(Effect.ensuring(Effect.sync(() => registry.dispose())))
      );

      const selectRequirements = (
        command: Extract<AndroidWorkspaceCommand, { readonly _tag: "start" }>
      ) =>
        Effect.gen(function* selectAndroidRequirements() {
          const { selection } = command;
          let taught: PlatformRequirements = {
            capabilities: ["semantic-actions", "screenshots"],
            environment: selection.environment,
            outcomes: selection.outcomes,
            platform: "android",
            preparation: selection.setup,
            reversibleActions: selection.reversibleActions,
          };
          let { recordingId } = command;
          if (command.kind === "teaching") {
            recordingId = TeachingRecordingId.make(`recording-${randomUUID()}`);
          } else {
            const recordingRoot =
              command.kind === "dry-run" && command.recordingId !== null
                ? path.dirname(
                    path.dirname(store.directory(command.recordingId))
                  )
                : undefined;
            const skill = yield* catalog.read(
              command.flowSkillName,
              recordingRoot
            );
            if (
              skill.runtime?.diagnostics.length !== 0 ||
              skill.runtime.requirements.platform !== "android"
            ) {
              return yield* denied(
                "Select a valid Android Flow Skill. Browser verification cannot authorize Android."
              );
            }
            taught = skill.runtime.requirements;
            if (!supportsWorkspaceRequirements(taught, skill.inputs.length)) {
              return yield* denied(
                "This experimental Android journey requires declared preparation and outcomes and supports no Variable inputs."
              );
            }
            if (command.kind === "run") {
              const verified = skill.files.find(
                (file) => file.path === "references/verification.md"
              );
              if (
                !verified?.content.includes("- Platform: android") ||
                !verified.content.includes("- Verified:")
              ) {
                return yield* denied(
                  "A later Android Run requires explicit Android verification."
                );
              }
              recordingId = null;
            } else {
              if (recordingId === null) {
                return yield* denied(
                  "An Android Dry Run requires its Teaching Recording."
                );
              }
              const manifest = yield* store.read(recordingId);
              if (
                manifest.flowSkillName !== command.flowSkillName ||
                JSON.stringify(manifest.runtime) !== JSON.stringify(taught) ||
                manifest.runtime?.platform !== "android" ||
                (manifest.lifecycle._tag !== "skill-drafted" &&
                  manifest.lifecycle._tag !== "dry-run-failed")
              ) {
                return yield* denied(
                  "The Android recording is not ready for this Flow Skill's Dry Run."
                );
              }
            }
          }
          return { recordingId, taught };
        });
      const start = (
        command: Extract<AndroidWorkspaceCommand, { readonly _tag: "start" }>,
        source: "agent" | "user"
      ) =>
        startLock.withPermits(1)(
          Effect.gen(function* startWorkspace() {
            const fingerprint = JSON.stringify(command);
            const replay = starts.get(command.operationId);
            if (replay !== undefined) {
              if (replay.fingerprint !== fingerprint) {
                return yield* denied(
                  "The startup operation was already used with different declarations."
                );
              }
              const retained = sessions.get(replay.id);
              if (retained !== undefined) {
                return yield* snapshot(retained, source === "user");
              }
            }
            const { selection } = command;
            const { taught, recordingId } = yield* selectRequirements(command);
            const id = AgentSessionId.make(
              `agent-android-${hash(command.operationId).slice(0, 32)}`
            );
            const scope = yield* Scope.make();
            const startup: AndroidRunInput = {
              device: selection.device,
              environment: selection.environment,
              platform: "android",
              requiredCapabilities: taught.capabilities,
              reversibleActions:
                taught.platform === "android"
                  ? (taught.reversibleActions ?? [])
                  : [],
              scope,
              setup: selection.setup,
              targetApp: selection.environment.appId,
              taught,
            };
            const create =
              selection.helperConsent === "none"
                ? factory.android.createRun(startup)
                : factory.android.createRun({
                    ...startup,
                    installationGrant: {
                      operation: selection.helperConsent,
                      serial: selection.device.serial,
                      sha256: androidHelperRelease.sha256,
                    },
                  });
            const created = yield* Effect.result(create);
            if (Result.isFailure(created)) {
              yield* Scope.close(scope, Exit.void);
              return yield* Effect.fail(created.failure);
            }
            const run = created.success;
            const root =
              command.kind === "dry-run" && recordingId !== null
                ? path.dirname(path.dirname(store.directory(recordingId)))
                : catalog.root();
            let directory = path.join(root, "agent-runs", id);
            if (recordingId !== null) {
              directory =
                command.kind === "teaching"
                  ? store.directory(recordingId)
                  : path.join(store.directory(recordingId), "android-runs", id);
            }
            const summary: AndroidWorkspaceSummary = {
              assessment: null,
              captureGaps: [],
              completedAt: null,
              controller: command.kind === "teaching" ? "user" : "agent",
              error: null,
              experimental: true,
              flowSkillName: command.flowSkillName,
              id,
              kind: command.kind,
              phase: "pending",
              preparation: run.state(),
              recordingId,
              requirements: taught,
              selection,
              startedAt: now(),
              takeoverOccurred: false,
            };
            const session: Session = {
              directory,
              lock: Semaphore.makeUnsafe(1),
              receipts: new Map(),
              run,
              scope,
              state: Atom.make<SessionState>({
                artifacts: [],
                bytes: 0,
                observation: null,
                observations: [],
                recording: false,
                revision: 0,
                sequence: 0,
                summary,
              }).pipe(Atom.keepAlive),
              stream: yield* acquireAndroidStream(id, selection.device, scope),
              summaryFile: path.join(root, ".android-workspace", `${id}.json`),
            };
            registry.get(session.state);
            sessions.set(id, session);
            starts.set(command.operationId, { fingerprint, id });
            const initialized = yield* Effect.result(
              Effect.gen(function* initializeCapture() {
                yield* io(fs.makeDirectory(directory, { recursive: true }));
                if (recordingId !== null && command.kind === "teaching") {
                  yield* store.begin({
                    emulation: null,
                    flowSkillName: command.flowSkillName,
                    operationId: command.operationId,
                    recordingId,
                    runtime: taught,
                    sessionId: id,
                  });
                }
                if (recordingId !== null && command.kind === "dry-run") {
                  yield* store.startDryRun({
                    inputs: [],
                    operationId: command.operationId,
                    recordingId,
                    sessionId: id,
                  });
                }
                yield* persist(session);
                return yield* snapshot(session, source === "user");
              })
            );
            if (Result.isFailure(initialized)) {
              yield* close(session).pipe(Effect.ignore);
              return yield* Effect.fail(initialized.failure);
            }
            return initialized.success;
          })
        );

      const recordWorkspace = (
        session: Session,
        command: Extract<AndroidWorkspaceCommand, { readonly _tag: "record" }>,
        source: "agent" | "user"
      ) =>
        Effect.gen(function* recordWorkspaceCommand() {
          const current = state(session);
          const { summary } = current;
          if (
            source !== "user" ||
            summary.kind !== "teaching" ||
            summary.recordingId === null ||
            summary.phase !== "running"
          ) {
            return yield* denied(
              "Teaching Start and Stop require user-held, prepared Workspace."
            );
          }
          if (command.start) {
            const manifest = yield* store.read(summary.recordingId);
            if (manifest.lifecycle._tag !== "setup") {
              return yield* denied(
                "Start a new complete Teaching session for another recording."
              );
            }
            yield* store.start({
              emulation: null,
              operationId: command.operationId,
              recordingId: summary.recordingId,
            });
            update(session, (value) => ({ ...value, recording: true }));
            yield* emit(session, {
              _tag: "started",
              emulation: null,
              url: "",
            });
            const observed = yield* session.run.observe();
            acceptObservation(session, observed);
            yield* keyframe(session, observed, null);
          } else {
            yield* finishRecording(session, command.operationId);
          }
        });
      const inputWorkspace = (
        session: Session,
        command: Extract<AndroidWorkspaceCommand, { readonly _tag: "input" }>,
        source: "agent" | "user"
      ) =>
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* inputWorkspaceCommand() {
          const current = state(session);
          const { summary } = current;
          if (summary.controller !== source || summary.phase !== "running") {
            return yield* denied(
              "Only the current controller can forward Android input. Agent tools are disabled during Takeover."
            );
          }
          const selectedObservation = current.observations.find(
            (observation) => observation.id === command.observationId
          );
          if (selectedObservation === undefined) {
            return yield* denied(
              "This mirrored observation is stale. Refresh and choose the target again; input was not forwarded."
            );
          }
          const { action } = command;
          const selectedTarget =
            action._tag === "back"
              ? undefined
              : selectedObservation.nodes.find(
                  (node) => node.target === action.target
                );
          if (
            action._tag !== "back" &&
            (!selectedTarget ||
              selectedTarget.password ||
              selectedTarget.covered)
          ) {
            return yield* denied(
              "Select an uncovered non-private semantic target."
            );
          }
          // Semantic selection is resolved once before dispatch, never after a failed or uncertain command.
          // The stock backend's current generation is authoritative; coordinates remain unavailable.
          const before = yield* session.run.observe();
          acceptObservation(session, before);
          const matches =
            selectedTarget === undefined
              ? []
              : before.nodes.filter(
                  (node) =>
                    node.role === selectedTarget.role &&
                    node.name === selectedTarget.name &&
                    node.editable === selectedTarget.editable &&
                    !node.password &&
                    !node.covered &&
                    node.packageName === summary.selection.environment.appId
                );
          if (action._tag !== "back" && matches.length !== 1) {
            return yield* denied(
              "The selected semantic control changed or is ambiguous. Refresh and choose it again; no input was forwarded."
            );
          }
          const [target] = matches;
          if (
            action._tag === "back" &&
            semanticSignature(before.nodes) !==
              semanticSignature(selectedObservation.nodes)
          ) {
            return yield* denied(
              "The screen changed before Back. Inspect the fresh screen and choose Back again."
            );
          }
          if (action._tag === "fill" && /[^\u0020-\u007E]/u.test(action.text)) {
            return yield* denied(
              "Only public ASCII fixture text is supported. Private Variables are unavailable."
            );
          }
          const actionId = `android-action-${randomUUID()}`;
          update(session, (value) => ({ ...value, observation: null }));
          const forwarded =
            action._tag === "back"
              ? session.run.back(before.id)
              : session.run.dispatch(
                  before.id,
                  action._tag === "fill"
                    ? {
                        target: target?.target ?? "",
                        text: action.text,
                        type: "fill",
                      }
                    : { target: target?.target ?? "", type: "activate" }
                );
          yield* forwarded;
          const after = yield* session.run.observe();
          acceptObservation(session, after);
          if (current.recording) {
            yield* keyframe(session, before, actionId);
            yield* emit(session, {
              _tag: "action",
              after: observationSummary(after),
              appeared: difference(after, before),
              before: observationSummary(before),
              description:
                action._tag === "back"
                  ? "Go back"
                  : `${action._tag === "fill" ? "Enter public fixture text in" : "Activate"} ${target?.role} ${target?.name}`,
              detail: action._tag === "fill" ? action.text : null,
              disappeared: difference(before, after),
              id: actionId,
              kind: action._tag,
              outcome: "succeeded",
              target:
                target === undefined
                  ? null
                  : {
                      checked: null,
                      context: [summary.selection.environment.appId],
                      disabled: null,
                      name: target.name,
                      role: target.role,
                      value: null,
                      valueWithheld: null,
                    },
            });
            yield* keyframe(session, after, actionId);
          } else if (summary.kind !== "teaching") {
            yield* io(
              fs.writeFileString(
                path.join(session.directory, "actions.jsonl"),
                `${JSON.stringify({ action: action._tag, actionId, after: after.id, at: now(), before: before.id, controller: source })}\n`,
                { flag: "a", mode: 0o600 }
              )
            );
            yield* keyframe(session, after, actionId);
          }
        });
      const completeWorkspace = (
        session: Session,
        command: Extract<
          AndroidWorkspaceCommand,
          { readonly _tag: "complete" }
        >,
        source: "agent" | "user"
      ) =>
        Effect.gen(function* completeWorkspaceCommand() {
          const current = state(session);
          const { summary } = current;
          if (
            source !== "agent" ||
            summary.controller !== "agent" ||
            summary.kind === "teaching"
          ) {
            return yield* denied(
              "Return control before the agent assesses its Run."
            );
          }
          const { observation } = current;
          if (
            !observation ||
            command.assessment.observationId !== observation.id
          ) {
            return yield* denied(
              "Assess with the latest retained observation."
            );
          }
          yield* keyframe(session, observation, null);
          const validatedOutcome = yield* session.run.observe();
          acceptObservation(session, validatedOutcome);
          yield* keyframe(session, validatedOutcome, null);
          const { requirements } = summary;
          const supportedOutcome =
            requirements.platform === "android" &&
            !!requirements.outcomes?.length &&
            requirements.outcomes.every(
              (condition) =>
                visible(observation, condition) &&
                visible(validatedOutcome, condition)
            );
          const passing =
            command.assessment.outcome === "working" &&
            supportedOutcome &&
            !summary.takeoverOccurred &&
            summary.captureGaps.length === 0;
          const assessment = {
            ...command.assessment,
            outcome:
              command.assessment.outcome === "working" && !passing
                ? ("inconclusive" as const)
                : command.assessment.outcome,
          };
          update(session, (value) => ({
            ...value,
            summary: {
              ...value.summary,
              assessment,
              completedAt: now(),
              phase: "completed",
            },
          }));
          yield* session.run.close();
          yield* Scope.close(session.scope, Exit.void);
          yield* persist(session);
          if (summary.kind === "dry-run" && summary.recordingId !== null) {
            const report = {
              observableOutcome: `${assessment.outcome}: ${assessment.explanation}`,
              operationId: command.operationId,
              recordingId: summary.recordingId,
            };
            yield* passing
              ? store.passDryRun(report)
              : store.failDryRun(report);
          }
        });
      const perform = (
        session: Session,
        command: Exclude<AndroidWorkspaceCommand, { readonly _tag: "start" }>,
        source: "agent" | "user"
      ) =>
        // Closed command dispatch; capture, input, and assessment have separate handlers.
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* performWorkspaceCommand() {
          const current = state(session);
          const { summary } = current;
          const terminal =
            summary.phase === "closed" ||
            summary.phase === "completed" ||
            summary.phase === "refused";
          if (command._tag === "read") {
            return yield* snapshot(session, source === "user");
          }
          if (command._tag === "flow-decision") {
            if (source !== "user" || summary.recordingId === null) {
              return yield* denied(
                "Verification and rejection require an explicit Workspace choice."
              );
            }
            const decided = yield* decideFlowSkill({
              ...command,
              recordingId: summary.recordingId,
            }).pipe(Effect.provideService(TeachingRecordingStore, store));
            if (decided.cleanup._tag === "purged") {
              for (const owned of sessions.values()) {
                if (state(owned).summary.recordingId === summary.recordingId) {
                  update(owned, (value) => ({
                    ...value,
                    artifacts: [],
                    observation: null,
                    observations: [],
                  }));
                }
              }
            }
            return yield* snapshot(session);
          }
          if (command._tag === "close") {
            if (source !== "user" && summary.controller === "user") {
              return yield* denied(
                "The user holds this session. Request explicit return of control."
              );
            }
            yield* close(session);
            return yield* snapshot(session);
          }
          if (terminal) {
            return yield* denied(
              "This Android session has ended. Open a new prepared session."
            );
          }
          if (command._tag === "decide") {
            if (source !== "user") {
              return yield* denied(
                "Run Environment Permission requires an explicit Workspace choice."
              );
            }
            yield* session.run.decide(command.decisionId, command.allow);
            if (!command.allow) {
              update(session, (value) => ({
                ...value,
                summary: { ...value.summary, phase: "refused" },
              }));
            }
          } else if (command._tag === "prepare") {
            if (source !== "user") {
              return yield* denied(
                "Preparation requires the user's Workspace action."
              );
            }
            acceptObservation(session, yield* session.run.prepare());
          } else if (command._tag === "recover") {
            if (source !== "user") {
              return yield* denied(
                "Recovery requires an explicit same-device Workspace action."
              );
            }
            acceptObservation(session, yield* session.run.recover());
          } else if (command._tag === "observe") {
            if (summary.phase !== "running") {
              return yield* denied(
                "Prepare or explicitly recover this selected device first."
              );
            }
            if (source === "agent" || summary.controller === "user") {
              acceptObservation(
                session,
                yield* source === "user"
                  ? session.run.mirror()
                  : session.run.observe()
              );
            }
            return yield* snapshot(session, command.image && source === "user");
          } else if (command._tag === "control") {
            if (source !== "user" || summary.kind === "teaching") {
              return yield* denied(
                "Run control changes require Workspace. Teaching remains user-led."
              );
            }
            update(session, (value) => ({
              ...value,
              observation: null,
              observations: [],
              summary: {
                ...value.summary,
                controller: command.controller,
                takeoverOccurred:
                  value.summary.takeoverOccurred ||
                  command.controller === "user",
              },
            }));
            acceptObservation(session, yield* session.run.observe());
          } else if (command._tag === "record") {
            yield* recordWorkspace(session, command, source);
          } else if (command._tag === "instruction") {
            if (source !== "user" || !current.recording) {
              return yield* denied(
                "Record Instructions in Workspace during Teaching."
              );
            }
            yield* emit(session, {
              _tag: "instruction",
              target: null,
              text: command.text,
            });
          } else if (command._tag === "input") {
            yield* inputWorkspace(session, command, source);
          } else if (command._tag === "complete") {
            yield* completeWorkspace(session, command, source);
          }
          yield* persist(session);
          return yield* snapshot(session, source === "user");
        });

      const readPersisted = (id: AgentSessionId) =>
        io(
          fs.readFileString(
            path.join(options.root(), ".android-workspace", `${id}.json`)
          )
        ).pipe(
          Effect.flatMap((contents) =>
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(AndroidWorkspaceSummary)
            )(contents)
          ),
          Effect.mapError(() =>
            error(
              "android_session_not_found",
              "No valid persisted Android summary exists for this session."
            )
          )
        );
      const snapshotPersisted = (
        summary: AndroidWorkspaceSummary
      ): Effect.Effect<AndroidWorkspaceSnapshot, AndroidWorkspaceError> =>
        Effect.gen(function* reopenedSummary() {
          const recording = yield* recordingState(summary.recordingId);
          return {
            ...summary,
            ...recording,
            error:
              summary.completedAt === null
                ? "This process can read the retained Summary but does not own its device. Open the owning Workspace to drive it."
                : summary.error,
            observation: null,
            phase:
              summary.phase === "running" ||
              summary.phase === "pending" ||
              summary.phase === "paused"
                ? "closed"
                : summary.phase,
            revision: 0,
          };
        });
      return AndroidWorkspace.of({
        execute: (command, source) =>
          Effect.suspend(() => {
            if (command._tag === "start") {
              return start(command, source);
            }
            const session = sessions.get(command.sessionId);
            if (session === undefined) {
              return Effect.gen(function* persistedCommand() {
                if (
                  command._tag !== "read" &&
                  command._tag !== "flow-decision"
                ) {
                  return yield* denied(
                    "This process does not own the Android session. Reopen its persisted Summary or start a new session."
                  );
                }
                const summary = yield* readPersisted(command.sessionId);
                if (command._tag === "flow-decision") {
                  if (source !== "user" || summary.recordingId === null) {
                    return yield* denied(
                      "Verification and Cleanup require an explicit Workspace choice for its recording."
                    );
                  }
                  yield* decideFlowSkill({
                    ...command,
                    recordingId: summary.recordingId,
                  }).pipe(Effect.provideService(TeachingRecordingStore, store));
                }
                return yield* snapshotPersisted(summary);
              });
            }
            const serialized = session.lock.withPermits(1)(
              Effect.gen(function* serializedCommand() {
                const operationId =
                  "operationId" in command ? command.operationId : null;
                const fingerprint = JSON.stringify([source, command]);
                const receipt =
                  operationId === null
                    ? undefined
                    : session.receipts.get(operationId);
                if (receipt !== undefined) {
                  if (receipt.fingerprint !== fingerprint) {
                    return yield* denied(
                      "This operationId already names another Android attempt."
                    );
                  }
                  return yield* Result.isSuccess(receipt.result)
                    ? snapshot(session)
                    : Effect.fail(receipt.result.failure);
                }
                if (operationId !== null) {
                  session.receipts.set(operationId, {
                    fingerprint,
                    result: Result.fail(
                      error(
                        "execution_canceled",
                        "The attempt was reserved. It cannot be replayed after interruption; inspect and recover first."
                      )
                    ),
                  });
                }
                const attempted = perform(session, command, source).pipe(
                  Effect.tapError((cause) =>
                    cause.code === "android_workspace_refused"
                      ? Effect.void
                      : pause(session, cause).pipe(Effect.ignore)
                  ),
                  Effect.onInterrupt(() =>
                    pause(
                      session,
                      error(
                        "execution_canceled",
                        "Cancellation does not undo forwarded input. Recover with a fresh same-device observation."
                      )
                    ).pipe(Effect.ignore)
                  )
                );
                const result = yield* Effect.result(attempted);
                if (operationId !== null) {
                  session.receipts.set(operationId, {
                    fingerprint,
                    result: Result.isSuccess(result)
                      ? Result.succeed({ ...result.success, observation: null })
                      : result,
                  });
                }
                return yield* Result.isSuccess(result)
                  ? Effect.succeed(result.success)
                  : Effect.fail(result.failure);
              })
            );
            // A capture forwards no input, so a caller that stops waiting, such as a
            // closed mirror, must not pause the session or mark its capture incomplete.
            return command._tag === "observe"
              ? serialized.pipe(
                  Effect.forkIn(session.scope),
                  Effect.flatMap(Fiber.join)
                )
              : serialized;
          }),
        list: () =>
          Effect.gen(function* listWorkspace() {
            const directory = path.join(options.root(), ".android-workspace");
            if (!(yield* io(fs.exists(directory)))) {
              return [];
            }
            const files = yield* io(fs.readDirectory(directory));
            return yield* Effect.forEach(
              files.filter((file) =>
                /^agent-android-[a-f0-9]{32}\.json$/u.test(file)
              ),
              (file) => readPersisted(AgentSessionId.make(file.slice(0, -5)))
            );
          }),
        stream: (sessionId) =>
          Effect.sync(() => {
            const session = sessions.get(sessionId);
            if (
              !session ||
              !["running", "paused"].includes(state(session).summary.phase)
            ) {
              return null;
            }
            return session.stream;
          }),
      });
    })
  );
