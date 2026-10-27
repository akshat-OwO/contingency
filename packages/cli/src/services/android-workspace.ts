import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentSessionId,
  OperationId,
  TeachingRecordingId,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
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
  Redacted,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AndroidRun, AndroidRunInput } from "./android-run-contract.ts";
import {
  androidPrivateTextRelease,
  androidHelperRelease,
} from "./android-runtime-contract.ts";
import type { AndroidObservation } from "./android-runtime-contract.ts";
import { acquireAndroidStream } from "./android-stream.ts";
import type { AndroidDeviceStream } from "./android-stream.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { makeNativeAppTeachingCapture } from "./native-app-teaching-capture.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
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
  inputs: readonly { readonly name: string }[]
) =>
  requirements.platform === "android" &&
  requirements.preparation !== undefined &&
  (requirements.outcomes?.length ?? 0) > 0 &&
  (inputs.length === 0 ||
    requirements.capabilities.includes("private-input")) &&
  inputs.length <= 64 &&
  inputs.every(({ name }) =>
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(name.toUpperCase())
  ) &&
  new Set(inputs.map(({ name }) => name.toUpperCase())).size === inputs.length;
const privateTextGrant = (selection: AndroidWorkspaceSummary["selection"]) => {
  const operation = selection.privateHelperConsent;
  if (operation === undefined || operation === "none") {
    return;
  }
  return {
    operation,
    serial: selection.device.serial,
    sha256: androidPrivateTextRelease.sha256,
  };
};
const actionDescription = (
  action: Extract<
    AndroidWorkspaceCommand,
    { readonly _tag: "input" }
  >["action"],
  target: AndroidObservation["nodes"][number] | undefined
) => {
  // All action variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (action._tag) {
    case "variable": {
      return {
        description: `Enter {{${action.name}}} in ${target?.role} Private field`,
        detail: `{{${action.name}}}`,
      };
    }
    case "back": {
      return { description: "Go back", detail: null };
    }
    case "fill": {
      return {
        description: `Enter public fixture text in ${target?.role} ${target?.name}`,
        detail: action.text,
      };
    }
    case "activate": {
      return {
        description: `Activate ${target?.role} ${target?.name}`,
        detail: null,
      };
    }
  }
};
const satisfiesOutcomes = (
  requirements: PlatformRequirements,
  before: AndroidObservation | null,
  after: AndroidObservation | null
) =>
  before !== null &&
  after !== null &&
  requirements.platform === "android" &&
  !!requirements.outcomes?.length &&
  requirements.outcomes.every(
    (condition) => visible(before, condition) && visible(after, condition)
  );
/**
 * The Target App's semantic screen. Other windows, such as the status bar,
 * change on their own; ownership checks, not this comparison, cover them.
 */
const semanticSignature = (
  nodes: AndroidObservation["nodes"],
  targetApp: string
) =>
  JSON.stringify(
    nodes.flatMap(
      ({ role, name, editable, covered, password, packageName, bounds }) =>
        packageName === targetApp
          ? [{ bounds, covered, editable, name, packageName, password, role }]
          : []
    )
  );

const observationSize = (observation: AndroidObservation) => {
  const pixels = Buffer.from(observation.screenshot.image, "base64");
  return { height: pixels.readUInt32BE(20), width: pixels.readUInt32BE(16) };
};
const hitTest = (nodes: AndroidObservation["nodes"], x: number, y: number) => {
  let hit: AndroidObservation["nodes"][number] | undefined;
  let area = Infinity;
  for (const node of nodes) {
    const { bounds } = node;
    // An unnamed hittable node, such as a scroll container, has no semantic
    // identity to teach or replay, so a click there activates nothing.
    if (
      !(node.editable || (node.hittable && node.name.trim() !== "")) ||
      bounds === undefined ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      continue;
    }
    if (
      x < bounds.x ||
      y < bounds.y ||
      x > bounds.x + bounds.width ||
      y > bounds.y + bounds.height
    ) {
      continue;
    }
    const size = bounds.width * bounds.height;
    if (size < area) {
      hit = node;
      area = size;
    }
  }
  return hit;
};

interface SessionState {
  /** Bounded semantic selections only; historical frames never retain screenshot pixels. */
  readonly observations: readonly (Pick<AndroidObservation, "id" | "nodes"> & {
    readonly width: number;
    readonly height: number;
  })[];
  readonly field: AndroidWorkspaceSnapshot["field"];
  readonly revision: number;
  readonly summary: AndroidWorkspaceSummary;
  readonly observation: AndroidObservation | null;
  readonly recording: boolean;
  readonly sequence: number;
  readonly artifacts: readonly TeachingRecordingArtifact[];
  readonly bytes: number;
}
interface PrivateVariable {
  readonly name: string;
  readonly purpose: string;
  readonly setup: boolean;
  readonly requestId: string;
  readonly status: "requested" | "supplied" | "refused";
  readonly value?: Redacted.Redacted<string>;
}
interface Session {
  readonly variables: Atom.Writable<readonly PrivateVariable[]>;
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
      const receiptSalt = randomUUID();
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
      const clearVariables = (session: Session) => {
        for (const variable of registry.get(session.variables)) {
          if (variable.value !== undefined) {
            Redacted.wipeUnsafe(variable.value);
          }
        }
        registry.set(session.variables, []);
      };
      const update = (
        session: Session,
        change: (current: SessionState) => SessionState
      ) =>
        registry.update(session.state, (current) => {
          const next = change(current);
          return {
            ...next,
            field:
              next.summary.phase === "running" && next.observation !== null
                ? next.field
                : null,
            revision: current.revision + 1,
          };
        });
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
            field: current.field,
            observation:
              captured === null
                ? null
                : {
                    capturedAt: captured.screenshot.capturedAt,
                    ...observationSize(captured),
                    id: captured.id,
                    image: image ? captured.screenshot.image : null,
                    nodes: captured.nodes,
                  },
            preparation: session.run.state(),
            revision: current.revision,
            variables: registry
              .get(session.variables)
              .map(({ value: _value, ...variable }) => variable),
          } satisfies AndroidWorkspaceSnapshot;
        });
      const { emit, keyframe, finishRecording } = makeNativeAppTeachingCapture({
        directory: (session: Session) => session.directory,
        error,
        eventArtifactId: "android-events",
        fs,
        io,
        messages: {
          limit:
            "The Android capture limit was reached. Start a new complete recording.",
          sizeLimit: "The Android capture size limit was reached.",
        },
        state,
        store,
        update,
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
          field:
            current.field?.password !== true &&
            current.observation !== null &&
            semanticSignature(
              current.observation.nodes,
              current.summary.selection.environment.appId
            ) ===
              semanticSignature(
                observation.nodes,
                current.summary.selection.environment.appId
              )
              ? current.field
              : null,
          observation,
          observations: [
            ...current.observations.filter(
              (retained) => retained.id === current.field?.observationId
            ),
            ...current.observations
              .filter(
                (retained) => retained.id !== current.field?.observationId
              )
              .slice(-7),
            {
              id: observation.id,
              nodes: observation.nodes,
              ...observationSize(observation),
            },
          ],
          summary: { ...current.summary, error: null, phase: "running" },
        }));
      };
      const close = (session: Session) =>
        Effect.gen(function* closeWorkspace() {
          clearVariables(session);
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
            capabilities: selection.privateInput
              ? ["semantic-actions", "screenshots", "private-input"]
              : ["semantic-actions", "screenshots"],
            environment: selection.environment,
            outcomes: selection.outcomes,
            platform: "android",
            preparation: selection.setup,
            reversibleActions: [],
          };
          let inputs: readonly { readonly name: string }[] = [];
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
            ({ inputs } = skill);
            if (!supportsWorkspaceRequirements(taught, skill.inputs)) {
              return yield* denied(
                "This Android journey requires declared preparation and outcomes and supports named private inputs only."
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
          return { inputs, recordingId, taught };
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
            // The Support Matrix binds one device at a time; another live session keeps its binding.
            const bound = [...sessions.values()].find((session) =>
              ["pending", "running", "paused"].includes(
                state(session).summary.phase
              )
            );
            if (bound !== undefined) {
              const { id: boundId, selection: boundSelection } =
                state(bound).summary;
              const { serial } = boundSelection.device;
              return yield* denied(
                serial === selection.device.serial
                  ? `Android session ${boundId} is already bound to ${serial}. Close it before starting another session.`
                  : `Android binds one device at a time, and session ${boundId} is bound to ${serial}. Multiple bound devices are unsupported; close that session first.`
              );
            }
            const { taught, recordingId, inputs } =
              yield* selectRequirements(command);
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
              teaching: command.kind === "teaching",
            };
            const grant = privateTextGrant(selection);
            const authorizedStartup =
              grant === undefined
                ? startup
                : { ...startup, privateTextGrant: grant };
            const create =
              selection.helperConsent === "none"
                ? factory.android.createRun(authorizedStartup)
                : factory.android.createRun({
                    ...authorizedStartup,
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
              controller:
                command.kind === "teaching" && !command.agentSetup
                  ? "user"
                  : "agent",
              error: null,
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
                field: null,
                observation: null,
                observations: [],
                recording: false,
                revision: 0,
                sequence: 0,
                summary,
              }).pipe(Atom.keepAlive),
              stream: yield* acquireAndroidStream(id, selection.device, scope),
              summaryFile: path.join(root, ".android-workspace", `${id}.json`),
              variables: Atom.make<readonly PrivateVariable[]>(
                inputs.map(({ name }) => ({
                  name: name.toUpperCase(),
                  purpose: `Private input for ${command.flowSkillName}`,
                  requestId: randomUUID(),
                  setup: false,
                  status: "requested" as const,
                }))
              ).pipe(Atom.keepAlive),
            };
            registry.get(session.state);
            registry.get(session.variables);
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => clearVariables(session))
            );
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
                    inputs: inputs.map(({ name }) => ({
                      changed: false,
                      name,
                      value: null,
                    })),
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
            summary.phase !== "running" ||
            summary.controller !== "user"
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
        source: "agent" | "user",
        fresh?: AndroidObservation
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
          if (action._tag === "variable") {
            const bound =
              source === "agent"
                ? current.observation?.id === command.observationId
                : current.field?.observationId === command.observationId &&
                  current.field.target === action.target;
            if (!bound) {
              return yield* denied(
                "This private field observation is stale. Observe or pick the field again; no input was sent."
              );
            }
          }
          const selectedTarget =
            action._tag === "back"
              ? undefined
              : selectedObservation.nodes.find(
                  (node) => node.target === action.target
                );
          if (
            action._tag !== "back" &&
            (!selectedTarget ||
              selectedTarget.password !== (action._tag === "variable") ||
              selectedTarget.covered)
          ) {
            return yield* denied(
              "Select an uncovered semantic target. Password fields require a Variable."
            );
          }
          // Semantic selection is resolved once before dispatch, never after a failed or uncertain command.
          // The stock backend's current generation is authoritative; coordinates remain unavailable.
          const before =
            action._tag === "variable" && current.observation !== null
              ? current.observation
              : (fresh ?? (yield* session.run.observe()));
          if (fresh === undefined && action._tag !== "variable") {
            acceptObservation(session, before);
          }
          const { appId } = summary.selection.environment;
          const matches =
            selectedTarget === undefined
              ? []
              : before.nodes.filter(
                  (node) =>
                    node.role === selectedTarget.role &&
                    node.name === selectedTarget.name &&
                    node.editable === selectedTarget.editable &&
                    node.password === (action._tag === "variable") &&
                    (action._tag !== "variable" ||
                      (node.editable &&
                        JSON.stringify(node.bounds) ===
                          JSON.stringify(selectedTarget.bounds) &&
                        semanticSignature(before.nodes, appId) ===
                          semanticSignature(
                            selectedObservation.nodes,
                            appId
                          ))) &&
                    !node.covered &&
                    node.packageName === appId
                );
          if (action._tag !== "back" && matches.length !== 1) {
            return yield* denied(
              "The selected semantic control changed or is ambiguous. Refresh and choose it again; no input was forwarded."
            );
          }
          const [target] = matches;
          if (
            action._tag === "back" &&
            semanticSignature(before.nodes, appId) !==
              semanticSignature(selectedObservation.nodes, appId)
          ) {
            return yield* denied(
              "The screen changed before Back. Inspect the fresh screen and choose Back again."
            );
          }
          if (action._tag === "fill" && /[^\u0020-\u007E]/u.test(action.text)) {
            return yield* denied(
              "Use public ASCII text here, or select a Variable for a password field."
            );
          }
          const variable =
            action._tag === "variable"
              ? registry
                  .get(session.variables)
                  .find((entry) => entry.name === action.name)
              : undefined;
          if (
            action._tag === "variable" &&
            (!variable || variable.status !== "supplied" || !variable.value)
          ) {
            return yield* denied(
              "Request this Variable and have the user supply it in Workspace first."
            );
          }
          const actionId = `android-action-${randomUUID()}`;
          update(session, (value) => ({
            ...value,
            field: null,
            observation: null,
          }));
          if (action._tag === "variable") {
            yield* session.run.enterPrivate(before.id, {
              target: target?.target ?? "",
              value: Effect.suspend(() =>
                variable?.value === undefined
                  ? Effect.fail(platformRuntimeError("target_unsupported"))
                  : Effect.succeed(variable.value)
              ),
              variable: `{{${action.name}}}`,
            });
          } else if (action._tag === "back") {
            yield* session.run.back(before.id);
          } else {
            yield* session.run.dispatch(
              before.id,
              action._tag === "fill"
                ? {
                    target: target?.target ?? "",
                    text: action.text,
                    type: "fill",
                  }
                : { target: target?.target ?? "", type: "activate" }
            );
          }
          const after = yield* session.run.observe();
          acceptObservation(session, after);
          if (current.recording) {
            if (
              action._tag === "activate" &&
              target !== undefined &&
              summary.requirements.platform === "android"
            ) {
              const activated = summary.requirements.reversibleActions ?? [];
              if (
                !activated.some(
                  (node) =>
                    node.role === target.role && node.name === target.name
                )
              ) {
                const requirements = {
                  ...summary.requirements,
                  reversibleActions: [
                    ...activated,
                    { name: target.name, role: target.role },
                  ],
                };
                update(session, (value) => ({
                  ...value,
                  summary: { ...value.summary, requirements },
                }));
              }
            }
            yield* keyframe(session, before, actionId);
            yield* emit(session, {
              _tag: "action",
              actor: "user",
              after: observationSummary(after),
              appeared: difference(after, before),
              before: observationSummary(before),
              ...actionDescription(action, target),
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
                      valueWithheld: action._tag === "variable" ? true : null,
                    },
            });
            yield* keyframe(session, after, actionId);
          } else if (summary.kind !== "teaching") {
            yield* io(
              fs.writeFileString(
                path.join(session.directory, "actions.jsonl"),
                `${JSON.stringify({ action: action._tag, actionId, after: after.id, at: now(), before: before.id, controller: source, variable: action._tag === "variable" ? `{{${action.name}}}` : undefined })}\n`,
                { flag: "a", mode: 0o600 }
              )
            );
            yield* keyframe(session, after, actionId);
          }
        });
      const pickWorkspace = (
        session: Session,
        command: Extract<AndroidWorkspaceCommand, { readonly _tag: "pick" }>,
        source: "agent" | "user"
      ) =>
        Effect.gen(function* pickWorkspaceCommand() {
          const current = state(session);
          const { summary } = current;
          if (
            source !== "user" ||
            summary.controller !== source ||
            summary.phase !== "running"
          ) {
            return yield* denied(
              "Only the user controlling a running session can pick. No input was sent."
            );
          }
          const previous = current.observations.find(
            (observation) => observation.id === command.observationId
          );
          if (previous === undefined) {
            return yield* denied(
              "This mirrored observation is stale. Refresh and choose the target again; input was not forwarded."
            );
          }
          const observed = yield* session.run.observe();
          acceptObservation(session, observed);
          const { width, height } = observationSize(observed);
          const ratio = width / height;
          const frameRatio = command.frame.width / command.frame.height;
          if (
            Math.sign(width - height) !==
              Math.sign(command.frame.width - command.frame.height) ||
            Math.abs(frameRatio / ratio - 1) > 0.02
          ) {
            return yield* denied(
              "The stream size or orientation changed. No input was sent."
            );
          }
          const x = command.point.x * width;
          const y = command.point.y * height;
          // Resolve containing candidates first, so a private or foreign child cannot fall through to an eligible parent.
          const target = hitTest(observed.nodes, x, y);
          if (target === undefined || target.covered) {
            return yield* denied(
              "Nothing to activate there. No input was sent."
            );
          }
          if (target.packageName !== summary.selection.environment.appId) {
            return yield* denied(
              "That element belongs to another app. No input was sent."
            );
          }
          if (
            target.password &&
            !summary.requirements.capabilities.includes("private-input")
          ) {
            return yield* denied(
              "Private fields need a Variable. No input was sent."
            );
          }
          const priorTarget = hitTest(
            previous.nodes,
            command.point.x * previous.width,
            command.point.y * previous.height
          );
          if (
            priorTarget === undefined ||
            priorTarget.role !== target.role ||
            priorTarget.name !== target.name ||
            priorTarget.editable !== target.editable ||
            priorTarget.password !== target.password ||
            priorTarget.packageName !== target.packageName
          ) {
            return yield* denied(
              "The element moved or changed. No input was sent."
            );
          }
          if (target.editable) {
            update(session, (value) => ({
              ...value,
              field: {
                name: target.name,
                observationId: observed.id,
                password: target.password,
                role: target.role,
                target: target.target,
              },
            }));
            return;
          }
          yield* inputWorkspace(
            session,
            {
              _tag: "input",
              action: { _tag: "activate", target: target.target },
              observationId: observed.id,
              operationId: command.operationId,
              sessionId: command.sessionId,
            },
            source,
            observed
          );
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
          const secure = summary.captureGaps.includes("secure_window");
          if (
            !secure &&
            (!observation ||
              command.assessment.observationId !== observation.id)
          ) {
            return yield* denied(
              "Assess with the latest retained observation."
            );
          }
          const validatedOutcome = secure ? null : yield* session.run.observe();
          if (observation !== null && validatedOutcome !== null) {
            yield* keyframe(session, observation, null);
            acceptObservation(session, validatedOutcome);
            yield* keyframe(session, validatedOutcome, null);
          }
          const { requirements } = summary;
          const supportedOutcome = satisfiesOutcomes(
            requirements,
            observation,
            validatedOutcome
          );
          const passing =
            command.assessment.outcome === "working" &&
            supportedOutcome &&
            !summary.takeoverOccurred &&
            summary.captureGaps.length === 0;
          const assessment = {
            ...command.assessment,
            outcome:
              secure || (command.assessment.outcome === "working" && !passing)
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
          clearVariables(session);
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
          if (command._tag === "variable-request") {
            const setup =
              summary.kind === "teaching" &&
              summary.controller === "agent" &&
              current.sequence === 0;
            if (
              !summary.requirements.capabilities.includes("private-input") ||
              (summary.kind === "teaching" &&
                !setup &&
                !(source === "user" && current.recording)) ||
              (setup && source !== "agent")
            ) {
              return yield* denied(
                "Request private Variables during agent-held setup, user-led recording, or a Run with private input enabled."
              );
            }
            const variables = registry.get(session.variables);
            const existing = variables.find(
              (entry) => entry.name === command.name
            );
            if (
              (summary.kind !== "teaching" && !existing) ||
              (variables.length >= 64 && !existing)
            ) {
              return yield* denied(
                "Select a declared Flow Skill input; Teaching supports at most 64 Variables."
              );
            }
            if (!existing || command.replace) {
              if (existing?.value) {
                Redacted.wipeUnsafe(existing.value);
              }
              registry.set(session.variables, [
                ...variables.filter((entry) => entry.name !== command.name),
                {
                  name: command.name,
                  purpose: command.purpose,
                  requestId: command.operationId,
                  setup,
                  status: "requested",
                },
              ]);
            }
          } else if (command._tag === "variable-supply") {
            const variables = registry.get(session.variables);
            const existing = variables.find(
              (entry) =>
                entry.name === command.name &&
                entry.requestId === command.requestId
            );
            if (
              source !== "user" ||
              !existing ||
              existing.status !== "requested"
            ) {
              return yield* denied(
                "Only Workspace can answer the current private Variable request."
              );
            }
            registry.set(
              session.variables,
              variables.map((entry): PrivateVariable => {
                if (entry !== existing) {
                  return entry;
                }
                if (command.value === null) {
                  return { ...entry, status: "refused" };
                }
                return {
                  ...entry,
                  status: "supplied",
                  value: Redacted.make(command.value),
                };
              })
            );
          } else if (command._tag === "field-dismiss") {
            if (source !== "user" || summary.controller !== "user") {
              return yield* denied(
                "Only the user can dismiss a selected field."
              );
            }
            update(session, (value) => ({ ...value, field: null }));
          } else if (command._tag === "setup-handoff") {
            if (
              source !== "agent" ||
              summary.kind !== "teaching" ||
              summary.controller !== "agent" ||
              current.sequence !== 0
            ) {
              return yield* denied(
                "Only the setup agent can hand Teaching to the user, once and before recording."
              );
            }
            clearVariables(session);
            update(session, (value) => ({
              ...value,
              field: null,
              observation: null,
              observations: [],
              summary: { ...value.summary, controller: "user" },
            }));
          } else if (command._tag === "decide") {
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
            // Keep the exact private field observation alive while the user supplies
            // its Variable. The helper rechecks that binding before resolving a value.
            if (source === "user" && current.field?.password === true) {
              return yield* snapshot(session, command.image);
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
          } else if (command._tag === "pick") {
            yield* pickWorkspace(session, command, source);
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
            field: null,
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
                const fingerprint = hash(
                  `${receiptSalt}${JSON.stringify([source, command])}`
                );
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
