import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentRunId,
  AgentSessionId,
  OperationId,
  TeachingRecordingId,
  IosWorkspaceSummary,
  TeachingRecordingArtifact,
  startingDataOf,
} from "@contingency/protocol";
import type {
  IosWorkspaceCommand,
  IosObservationRefusal,
  IosWorkspaceSnapshot,
  FlowName,
  NativeForward,
  PlatformRequirements,
  RunVideoFastForward,
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
  Option,
  Semaphore,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  DEVICE_VIDEO_DIRECTORY,
  makeDeviceVideoCapture,
} from "./device-video-capture.ts";
import type { DeviceVideoCaptureSession } from "./device-video-capture.ts";
import { DeviceVideoRenderer } from "./device-video-renderer.ts";
import { makeExecutionBoundary } from "./execution-boundary.ts";
import type { ExecutionBoundary } from "./execution-boundary.ts";
import { FlowCatalog } from "./flow-catalog.ts";
import { makeIosHid } from "./ios-hid.ts";
import type { IosHid } from "./ios-hid.ts";
import {
  createIosRun,
  iosCapabilities,
  observeIosPostAction,
  iosRuntimeError as platformRuntimeError,
} from "./ios-runtime.ts";
import type { IosRun, IosRunInput, IosObservation } from "./ios-runtime.ts";
import { acquireIosStream } from "./ios-stream.ts";
import type { IosDeviceStream } from "./ios-stream.ts";
import { checkNativeAppConfirmation } from "./native-app-confirmation.ts";
import { relayedDecisionAllowed } from "./native-app-run.ts";
import { makeNativeAppTeachingCapture } from "./native-app-teaching-capture.ts";
import { describeGesture } from "./native-forwarded-input.ts";
import { makeForwardedLane } from "./native-forwarded-lane.ts";
import type { ForwardedLane, PendingGesture } from "./native-forwarded-lane.ts";
import {
  nativeRunDirectory,
  nativeRunSummary,
  writeNativeRunSummary,
} from "./native-run-summary.ts";
import type { NativeScreenRecorder } from "./native-screen-recorder.ts";
import type { PlatformFillResult } from "./platform-runtime.ts";
import { isVerifiedFlow } from "./requested-flows.ts";
import { TargetAppBuilds } from "./target-app-builds.ts";
import type {
  ClaimedTargetAppBuild,
  TargetAppBuildsService,
} from "./target-app-builds.ts";
import { decideFlow } from "./teaching-recording-orchestration.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";

export interface IosWorkspaceError {
  readonly code: string;
  readonly message: string;
}
const error = (code: string, message: string): IosWorkspaceError => ({
  code,
  message,
});
const denied = (message: string) =>
  Effect.fail(error("ios_workspace_refused", message));
/** Claims an uploaded build for a session, refusing any other path. */
const claimBuild = (
  builds: Option.Option<TargetAppBuildsService>,
  platform: "ios" | "android",
  buildPath: string,
  scope: Scope.Closeable
): Effect.Effect<ClaimedTargetAppBuild, IosWorkspaceError> =>
  // A refused claim closes the session scope it was given.
  (Option.isNone(builds)
    ? denied("Uploaded builds are unavailable in this process.")
    : builds.value
        .claim(platform, buildPath, scope)
        .pipe(
          Effect.mapError((refusal) =>
            error("ios_workspace_refused", refusal.message)
          )
        )
  ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const iosWorkspaceRefusal = (
  code: string
): IosObservationRefusal | null => {
  if (code === "foreign_app_foreground") {
    return { code: "foreign_app_foreground", recovery: "return-to-target-app" };
  }
  if (code === "capture_incomplete") {
    return { code: "capture_incomplete", recovery: "recover" };
  }
  return null;
};
const now = () => new Date().toISOString();
const observationSummary = (observation: IosObservation) => ({
  ios: {
    nodes: observation.nodes.flatMap((node) =>
      node.password ? [] : [{ name: node.name, role: node.role }]
    ),
    observationId: observation.id,
    screenshotCapturedAt: observation.screenshot.capturedAt,
  },
  nodeCount: observation.nodes.length,
  title: observation.appId ?? observation.device.name,
  url: "",
});
const boundaryObservationSummary = (observation: IosObservation) =>
  observationSummary({
    ...observation,
    nodes: observation.nodes.filter((node) => !node.password && !node.covered),
  });
const difference = (left: IosObservation, right: IosObservation) =>
  left.nodes.flatMap((node) =>
    node.password ||
    right.nodes.some(
      (other) => other.role === node.role && other.name === node.name
    )
      ? []
      : [{ name: node.name, role: node.role }]
  );
const visible = (
  observation: IosObservation,
  condition: { readonly role: string; readonly name: string }
) =>
  observation.nodes.some(
    (node) =>
      node.role === condition.role &&
      node.name === condition.name &&
      !node.password &&
      !node.covered
  );
const supportsWorkspaceRequirements = (
  requirements: PlatformRequirements,
  inputs: readonly { readonly name: string }[]
) =>
  requirements.platform === "ios" &&
  (requirements.preparation?.conditions.length ?? 0) > 0 &&
  (requirements.outcomes?.length ?? 0) > 0 &&
  inputs.length <= 64 &&
  inputs.every(({ name }) =>
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(name.toUpperCase())
  ) &&
  new Set(inputs.map(({ name }) => name.toUpperCase())).size === inputs.length;
const actionDescription = (
  action: Extract<IosWorkspaceCommand, { readonly _tag: "input" }>["action"],
  target: IosObservation["nodes"][number] | undefined,
  value: string | null
) => {
  // All action variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (action._tag) {
    case "variable": {
      return {
        description: `Enter Variable ${action.name}: ${value} in ${target?.role} ${target?.name}`,
        detail: value,
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
  before: IosObservation | null,
  after: IosObservation | null
) =>
  before !== null &&
  after !== null &&
  requirements.platform === "ios" &&
  !!requirements.outcomes?.length &&
  requirements.outcomes.every(
    (condition) => visible(before, condition) && visible(after, condition)
  );
/** Compare the visible OS controls before resolving a mirrored selection. */
const semanticSignature = (nodes: IosObservation["nodes"]) =>
  JSON.stringify(
    nodes.map(
      ({ role, name, editable, covered, password, packageName, bounds }) => ({
        bounds,
        covered,
        editable,
        name,
        packageName,
        password,
        role,
      })
    )
  );

const observationSize = (observation: IosObservation) => {
  const pixels = Buffer.from(observation.screenshot.image, "base64");
  return { height: pixels.readUInt32BE(20), width: pixels.readUInt32BE(16) };
};

interface SessionState {
  /** The session reached its first observation, so it is a Run that ran. */
  readonly ran: boolean;
  /** Bounded semantic selections only; historical frames never retain screenshot pixels. */
  readonly observations: readonly (Pick<IosObservation, "id" | "nodes"> & {
    readonly width: number;
    readonly height: number;
  })[];
  readonly startingObservation: ReturnType<typeof observationSummary> | null;
  readonly pendingInput: Extract<
    IosWorkspaceCommand,
    { readonly _tag: "input" }
  > | null;
  readonly field: IosWorkspaceSnapshot["field"];
  readonly revision: number;
  readonly summary: IosWorkspaceSummary;
  readonly observation: IosObservation | null;
  readonly recording: boolean;
  readonly sequence: number;
  readonly artifacts: readonly TeachingRecordingArtifact[];
  readonly bytes: number;
}
interface WorkspaceVariable {
  readonly name: string;
  readonly purpose: string;
  readonly setup: boolean;
  readonly requestId: string;
  readonly status: "requested" | "supplied" | "refused";
  readonly value?: Redacted.Redacted<string>;
}
type IosNode = IosObservation["nodes"][number];
interface Session {
  readonly boundary: ExecutionBoundary;
  readonly variables: Atom.Writable<readonly WorkspaceVariable[]>;
  readonly stream: IosDeviceStream;
  /** The simulator's input helper, for the user's Forwarded Input only. */
  readonly hid: IosHid;
  /** The user's Forwarded Input, which never waits on `lock`. */
  readonly lane: ForwardedLane<IosObservation, IosNode, IosWorkspaceError>;
  readonly state: Atom.Writable<SessionState>;
  readonly run: IosRun;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly receipts: Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Result.Result<IosWorkspaceSnapshot, IosWorkspaceError>;
    }
  >;
  readonly directory: string;
  readonly summaryFile: string;
  /** The device's own recording of Teaching, or of a Run's execution. */
  readonly video: DeviceVideoCaptureSession;
  /** Epoch milliseconds when a Takeover began. */
  readonly marks: {
    takeoverFrom?: number | undefined;
  };
}
export interface IosWorkspaceService {
  readonly stream: (
    sessionId: AgentSessionId
  ) => Effect.Effect<IosDeviceStream | null>;
  /**
   * The keyframes a session kept and the folder they are in, in any phase,
   * so an ended session's Run Summary can show them. Nothing for a session
   * this process does not know.
   */
  readonly keyframes: (sessionId: AgentSessionId) => Effect.Effect<{
    readonly directory: string;
    readonly keyframes: readonly TeachingRecordingArtifact[];
  } | null>;
  /**
   * Where a session's video is, in any phase: its folder, whether the
   * session is still recording into it, and whether Cleanup purged it.
   * Nothing for a session this process does not know.
   */
  readonly video: (sessionId: AgentSessionId) => Effect.Effect<{
    readonly folder: string;
    readonly live: boolean;
    readonly purged: boolean;
  } | null>;
  readonly execute: (
    command: IosWorkspaceCommand,
    source: "agent" | "user"
  ) => Effect.Effect<IosWorkspaceSnapshot, IosWorkspaceError>;
  /**
   * Sends the user's Forwarded Input to the device and answers once it is
   * written. It never waits on an observation and returns no snapshot.
   */
  readonly forward: (
    input: NativeForward,
    source: "agent" | "user"
  ) => Effect.Effect<void, IosWorkspaceError>;
  readonly activeRunFlowNames: () => Effect.Effect<readonly string[]>;
  readonly list: () => Effect.Effect<
    readonly IosWorkspaceSummary[],
    IosWorkspaceError
  >;
}
export const IosWorkspace = Context.Service<IosWorkspaceService>(
  "@contingency/IosWorkspace"
);

/** Selected-device mirror and capture. There is no stock hub, raw input route, or automatic replay. */
/** A session's persisted keyframes and the folder they are in. */
const KeyframeIndex = Schema.fromJsonString(
  Schema.Struct({
    directory: Schema.String,
    keyframes: Schema.Array(TeachingRecordingArtifact),
  })
);
/** Where a session's keyframe index sits beside its persisted summary. */
const keyframeIndexFile = (summaryFile: string) =>
  summaryFile.replace(/\.json$/u, ".keyframes.json");
/**
 * Ends the device's recording, closing a Takeover still under way, and
 * returns the video's time map. Idempotent; a second call answers the
 * same map.
 */
const endVideo = (session: Session) =>
  Effect.gen(function* endDeviceVideo() {
    const { takeoverFrom } = session.marks;
    if (takeoverFrom !== undefined) {
      session.marks.takeoverFrom = undefined;
      yield* session.video.takeover(takeoverFrom);
    }
    return yield* session.video.end;
  });

export const makeIosWorkspaceLayer = (options: {
  readonly root: () => string;
  readonly createRun?: typeof createIosRun;
  /** The simulator input helper; tests substitute their own. */
  readonly makeHid?: typeof makeIosHid;
  /** How a Run's video fast-forwards its Idle Gaps; one per process. */
  readonly videoFastForward?: RunVideoFastForward;
}) =>
  Layer.effect(
    IosWorkspace,
    Effect.gen(function* makeWorkspace() {
      const makeHid = options.makeHid ?? makeIosHid;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* TeachingRecordingStore;
      const catalog = yield* FlowCatalog;
      const builds = yield* Effect.serviceOption(TargetAppBuilds);
      const renderer = yield* Effect.serviceOption(DeviceVideoRenderer);

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
              "ios_evidence_io",
              "Could not retain iOS evidence. Input is paused; inspect local retained files."
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
          // The keyframes and their folder outlive this process beside the
          // summary, so a reopened session's Run Summary can still show them.
          const keyframes = keyframeIndexFile(session.summaryFile);
          yield* io(
            fs.writeFileString(
              `${keyframes}.tmp`,
              JSON.stringify({
                directory: session.directory,
                keyframes: state(session).artifacts.filter(
                  (artifact) => artifact.kind === "keyframe"
                ),
              }),
              { mode: 0o600 }
            )
          );
          yield* io(fs.rename(`${keyframes}.tmp`, keyframes));
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
      ): Effect.Effect<IosWorkspaceSnapshot, IosWorkspaceError> =>
        Effect.gen(function* snapshotWorkspace() {
          const current = state(session);
          const recording = yield* recordingState(current.summary.recordingId);
          const captured = current.observation;
          const pending = session.boundary.pending();
          return {
            ...current.summary,
            ...recording,
            boundary: session.boundary.pending()?.boundary ?? null,
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
            pendingDecision: session.boundary.pending()?.decision ?? null,
            preparation: {
              ...session.run.state(),
              pending: [
                ...session.run.state().pending,
                ...(pending === undefined
                  ? []
                  : [
                      {
                        id: pending.decision.pendingDecisionId,
                        kind: "confirmation" as const,
                        targetApp:
                          current.summary.selection.environment.bundleId,
                      },
                    ]),
              ],
            },
            revision: current.revision,
            variables: registry
              .get(session.variables)
              .map(({ value: _value, ...variable }) => variable),
          } satisfies IosWorkspaceSnapshot;
        });
      const { emit, keyframe, finishRecording } = makeNativeAppTeachingCapture({
        directory: (session: Session) => session.directory,
        error,
        eventArtifactId: "ios-events",
        fs,
        io,
        messages: {
          limit:
            "The iOS capture limit was reached. Start a new complete recording.",
          sizeLimit: "The iOS capture size limit was reached.",
        },
        state,
        stopSources: (session) =>
          Effect.gen(function* stopIosCaptureSources() {
            // Stop finalizes the device's recording first; nothing after
            // Stop is retained.
            yield* session.video.end;
            const interval = yield* session.stream.end();
            yield* io(
              fs.writeFileString(
                path.join(session.directory, "ios-stream.json"),
                JSON.stringify(interval),
                { mode: 0o600 }
              )
            );
            if (interval?.status === "incomplete") {
              return yield* Effect.fail(
                error(
                  "capture_incomplete",
                  "iOS transport evidence is incomplete."
                )
              );
            }
          }),
        store,
        update,
      });
      const pause = (session: Session, cause: IosWorkspaceError) =>
        Effect.gen(function* pauseInput() {
          update(session, (current) => ({
            ...current,
            observation: null,
            observations: [],
            summary: {
              ...current.summary,
              captureGaps:
                cause.code === "foreign_app_foreground"
                  ? current.summary.captureGaps
                  : [...current.summary.captureGaps, cause.code],
              error: cause.message,
              phase: "paused",
              refusal: iosWorkspaceRefusal(cause.code),
            },
          }));
          if (cause.code !== "foreign_app_foreground") {
            yield* finishRecording(
              session,
              OperationId.make(`ios-gap-${randomUUID()}`),
              cause.message
            );
          }
          yield* persist(session);
        });
      const acceptObservation = (
        session: Session,
        observation: IosObservation,
        {
          started = session.lane.observing(),
        }: {
          /** The input count when the observation began. */
          readonly started?: number;
        } = {}
      ) => {
        session.lane.observed(started);
        update(session, (current) => ({
          ...current,
          field:
            current.field?.password !== true &&
            current.observation !== null &&
            semanticSignature(current.observation.nodes) ===
              semanticSignature(observation.nodes)
              ? current.field
              : null,
          observation,
          observations: [
            ...current.observations.filter(
              (retained) =>
                retained.id === current.field?.observationId ||
                retained.id === current.pendingInput?.observationId
            ),
            ...current.observations
              .filter(
                (retained) =>
                  retained.id !== current.field?.observationId &&
                  retained.id !== current.pendingInput?.observationId
              )
              .slice(-7),
            {
              id: observation.id,
              nodes: observation.nodes,
              ...observationSize(observation),
            },
          ],
          ran: true,
          summary: {
            ...current.summary,
            error: null,
            phase: "running",
            refusal: null,
          },
        }));
      };
      /**
       * Leaves the Run Summary of a Run or Dry Run that ran, once, as it ends
       * (ADR 0078). Teaching, refused, and never-prepared sessions leave none.
       */
      const writeRunSummary = (
        session: Session,
        outcome: "completed" | "user-closed" | "interrupted" | "process-exited"
      ) =>
        Effect.gen(function* writeSummary() {
          const current = state(session);
          const videoTimeMap = yield* endVideo(session);
          const summary = nativeRunSummary({
            endedAt: current.summary.completedAt ?? now(),
            outcome,
            platform: "ios",
            ran: current.ran,
            summary: current.summary,
            videoTimeMap,
          });
          if (summary !== null) {
            yield* io(writeNativeRunSummary(fs, session.directory, summary));
          }
        });
      /**
       * A session's device video: Teaching in real time, a Run or Dry Run
       * condensed, rendered by this process once it ends.
       */
      const sessionVideo = (
        kind: "teaching" | "dry-run" | "run",
        directory: string,
        run: { readonly screenRecorder: () => NativeScreenRecorder | undefined }
      ) =>
        makeDeviceVideoCapture({
          directory,
          fastForward: options.videoFastForward ?? "capped",
          pacing: kind === "teaching" ? "real-time" : "condensed",
          platform: "ios",
          recorder: () => run.screenRecorder(),
          ...Option.match(renderer, {
            onNone: () => ({}),
            onSome: (service) => ({ render: service.render }),
          }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      /** A Run files its evidence under its Flow, as the Run store does. */
      const evidenceDirectory = (
        command: { readonly flowName: FlowName; readonly kind: string },
        root: string,
        id: AgentSessionId
      ) =>
        command.kind === "run"
          ? io(nativeRunDirectory(root, command.flowName, id, fs))
          : Effect.succeed(path.join(root, "runs", id));
      /**
       * Ends a Dry Run that never passed, so its recording can be dry-run
       * again. A no-op for other sessions and a Dry Run already settled.
       */
      const failActiveDryRun = (session: Session, observableOutcome: string) =>
        Effect.gen(function* failDryRunRecording() {
          const current = state(session).summary;
          if (current.kind !== "dry-run" || current.recordingId === null) {
            return;
          }
          const manifest = yield* store.read(current.recordingId);
          if (manifest.lifecycle._tag === "dry-running") {
            yield* store.failDryRun({
              observableOutcome,
              operationId: OperationId.make(`ios-close-run-${randomUUID()}`),
              recordingId: current.recordingId,
            });
          }
        });
      const terminalPhase = (session: Session) => {
        const { phase } = state(session).summary;
        return (
          phase === "closed" || phase === "completed" || phase === "refused"
        );
      };
      const close = (
        session: Session,
        outcome: "user-closed" | "interrupted" | "process-exited"
      ) =>
        Effect.gen(function* closeWorkspace() {
          // An ended session already released everything and keeps its outcome.
          if (terminalPhase(session)) {
            return;
          }
          clearVariables(session);
          yield* finishRecording(
            session,
            OperationId.make(`ios-close-${randomUUID()}`),
            "The session closed during capture."
          );
          yield* failActiveDryRun(
            session,
            "The session closed before a complete passing assessment. Cancellation does not undo input."
          );
          // The recorder belongs to the device runtime; stop it first.
          yield* endVideo(session);
          yield* session.stream.close();
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
          yield* writeRunSummary(session, outcome);
        });
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...sessions.values()],
          (session) =>
            session.lock
              .withPermits(1)(close(session, "process-exited"))
              .pipe(Effect.ignore),
          { discard: true }
        ).pipe(Effect.ensuring(Effect.sync(() => registry.dispose())))
      );

      const selectRequirements = (
        command: Extract<IosWorkspaceCommand, { readonly _tag: "start" }>
      ) =>
        Effect.gen(function* selectIosRequirements() {
          const { selection } = command;
          let taught: PlatformRequirements = {
            capabilities: [...iosCapabilities],
            environment: selection.environment,
            outcomes: selection.outcomes,
            platform: "ios",
            preparation: selection.setup,
          };
          let inputs: readonly { readonly name: string }[] = [];
          let { recordingId } = command;
          if (command.kind === "teaching") {
            recordingId = TeachingRecordingId.make(`recording-${randomUUID()}`);
          } else {
            const recordingRoot =
              command.kind === "dry-run" && command.recordingId !== null
                ? store.catalogRoot(command.recordingId)
                : undefined;
            const flow = yield* catalog.read(command.flowName, recordingRoot);
            if (
              flow.runtime?.diagnostics.length !== 0 ||
              flow.runtime.requirements.platform !== "ios"
            ) {
              return yield* denied(
                "Select a valid iOS Flow. Browser verification cannot authorize iOS."
              );
            }
            taught = flow.runtime.requirements;
            ({ inputs } = flow);
            if (!supportsWorkspaceRequirements(taught, flow.inputs)) {
              return yield* denied(
                "This iOS journey requires declared preparation and outcomes and supports named inputs only."
              );
            }
            if (command.kind === "run") {
              if (!isVerifiedFlow(flow.files, "ios")) {
                return yield* denied(
                  "A later iOS Run requires explicit iOS verification."
                );
              }
              recordingId = null;
            } else {
              if (recordingId === null) {
                return yield* denied(
                  "An iOS Dry Run requires its Teaching Recording."
                );
              }
              const manifest = yield* store.read(recordingId);
              if (
                manifest.flowName !== command.flowName ||
                JSON.stringify(manifest.runtime) !== JSON.stringify(taught) ||
                manifest.runtime?.platform !== "ios" ||
                (manifest.lifecycle._tag !== "flow-drafted" &&
                  manifest.lifecycle._tag !== "dry-run-failed")
              ) {
                return yield* denied(
                  "The iOS recording is not ready for this Flow's Dry Run."
                );
              }
            }
          }
          // A Dry Run or Run applies its saved Flow's setup, including its
          // Starting Data, never the selection's (ADR 0081).
          const { startingData: _selected, ...fallback } = selection.setup;
          const setup =
            command.kind !== "teaching" && taught.platform === "ios"
              ? (taught.preparation ?? fallback)
              : selection.setup;
          return { inputs, recordingId, setup, taught };
        });
      const start = (
        command: Extract<IosWorkspaceCommand, { readonly _tag: "start" }>,
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
            const { device } = selection;
            if (device.kind === "physical") {
              return yield* Effect.fail(
                error(
                  "physical_device_unsupported",
                  "Physical iPhones are unsupported. Select an iPhone simulator."
                )
              );
            }
            // The Support Matrix binds one device at a time; another live session keeps its binding.
            const bound = [...sessions.values()].find((session) =>
              ["pending", "running", "paused"].includes(
                state(session).summary.phase
              )
            );
            if (bound !== undefined) {
              const { id: boundId, selection: boundSelection } =
                state(bound).summary;
              const { udid: serial } = boundSelection.device;
              return yield* denied(
                serial === device.udid
                  ? `iOS session ${boundId} is already bound to ${serial}. Close it before starting another session.`
                  : `iOS binds one device at a time, and session ${boundId} is bound to ${serial}. Multiple bound devices are unsupported; close that session first.`
              );
            }
            const { taught, recordingId, inputs, setup } =
              yield* selectRequirements(command);
            const id = AgentSessionId.make(
              `agent-ios-${hash(command.operationId).slice(0, 32)}`
            );
            const scope = yield* Scope.make();
            // An uploaded build belongs to this session: closing its scope
            // deletes the upload, including when startup fails.
            const appPath =
              selection.appPath === undefined
                ? undefined
                : (yield* claimBuild(builds, "ios", selection.appPath, scope))
                    .path;
            const startup: IosRunInput = {
              device,
              environment: selection.environment,
              platform: "ios",
              requiredCapabilities: taught.capabilities,
              scope,
              setup,
              targetApp: selection.environment.bundleId,
              taught,
              teaching: command.kind === "teaching",
            };
            const create = (options.createRun ?? createIosRun)(
              appPath === undefined ? startup : { ...startup, appPath }
            );
            const created = yield* Effect.result(create);
            if (Result.isFailure(created)) {
              yield* Scope.close(scope, Exit.void);
              return yield* Effect.fail(created.failure);
            }
            const run = created.success;
            const root =
              command.kind === "dry-run" && recordingId !== null
                ? store.catalogRoot(recordingId)
                : catalog.root();
            // A Run files its evidence under its Flow; a Dry Run's and
            // Teaching's directories come from the recording store below.
            let directory = yield* evidenceDirectory(command, root, id).pipe(
              Effect.onError(() => Scope.close(scope, Exit.void))
            );
            if (recordingId !== null) {
              if (command.kind === "teaching") {
                yield* store
                  .begin({
                    emulation: null,
                    flowName: command.flowName,
                    group: command.group,
                    operationId: command.operationId,
                    recordingId,
                    runtime: taught,
                    sessionId: id,
                  })
                  .pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
                directory = store.directory(recordingId);
              } else {
                directory = yield* store
                  .prepareDryRun(recordingId, AgentRunId.make(`agentrun-${id}`))
                  .pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
              }
            }
            const summary: IosWorkspaceSummary = {
              assessment: null,
              captureGaps: [],
              completedAt: null,
              controller:
                command.kind === "teaching" && !command.agentSetup
                  ? "user"
                  : "agent",
              error: null,
              flowName: command.flowName,
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
              boundary: makeExecutionBoundary({
                hosts: [],
                now: () => new Date(),
                scope: command.kind === "dry-run" ? "dry-run" : "interactive",
                sessionId: id,
              }),
              directory,
              hid: yield* makeHid(
                () =>
                  "udid" in selection.device ? selection.device.udid : null,
                scope
              ),
              lane: makeForwardedLane({
                focus: (target, observation) => {
                  update(session, (value) => ({
                    ...value,
                    field:
                      target === undefined || observation === null
                        ? null
                        : {
                            name: target.name,
                            observationId: observation.id,
                            password: target.password,
                            role: target.role,
                            target: target.target,
                          },
                  }));
                },
                frame: (observation) => ({
                  nodes: observation.nodes,
                  ...observationSize(observation),
                }),
                latest: () => state(session).observation,
                send: (batch) =>
                  session.hid
                    .forward(batch)
                    .pipe(
                      Effect.mapError((cause) =>
                        error("ios_workspace_refused", cause.message)
                      )
                    ),
              }),
              lock: Semaphore.makeUnsafe(1),
              marks: {},
              receipts: new Map(),
              run,
              scope,
              state: Atom.make<SessionState>({
                artifacts: [],
                bytes: 0,
                field: null,
                observation: null,
                observations: [],
                pendingInput: null,
                ran: false,
                recording: false,
                revision: 0,
                sequence: 0,
                startingObservation: null,
                summary,
              }).pipe(Atom.keepAlive),
              stream: yield* acquireIosStream(
                id,
                () => state(session).observation?.device ?? null,
                scope,
                (code) =>
                  session.lock
                    .withPermits(1)(pause(session, platformRuntimeError(code)))
                    .pipe(Effect.orDie),
                () => {
                  const observed = state(session).observation;
                  return observed ? observationSize(observed) : undefined;
                }
              ),
              summaryFile: path.join(root, ".ios-workspace", `${id}.json`),
              variables: Atom.make<readonly WorkspaceVariable[]>(
                inputs.map(({ name }) => ({
                  name: name.toUpperCase(),
                  purpose: `Input for ${command.flowName}`,
                  requestId: randomUUID(),
                  setup: false,
                  status: "requested" as const,
                }))
              ).pipe(Atom.keepAlive),
              video: yield* sessionVideo(command.kind, directory, run),
            };
            registry.get(session.state);
            registry.get(session.variables);
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                clearVariables(session);
                session.boundary.dispose();
              })
            );
            sessions.set(id, session);
            starts.set(command.operationId, { fingerprint, id });
            const initialized = yield* Effect.result(
              Effect.gen(function* initializeCapture() {
                yield* io(fs.makeDirectory(directory, { recursive: true }));
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
              yield* close(session, "interrupted").pipe(Effect.ignore);
              return yield* Effect.fail(initialized.failure);
            }
            return initialized.success;
          })
        );

      /** One forwarded gesture as Teaching or Run evidence, against the observation of its result. */
      const recordGesture = (
        session: Session,
        {
          gesture,
          before,
          target,
          inferred,
        }: PendingGesture<IosObservation, IosNode>,
        after: IosObservation
      ) =>
        Effect.gen(function* recordForwardedGesture() {
          const current = state(session);
          const actionId = `ios-action-${randomUUID()}`;
          const described = describeGesture(gesture, target);
          if (current.recording) {
            if (before !== null) {
              yield* keyframe(session, before, actionId);
            }
            yield* emit(session, {
              _tag: "action",
              actor: "user",
              after: observationSummary(after),
              appeared: before === null ? [] : difference(after, before),
              before: observationSummary(before ?? after),
              description: described.description,
              detail: described.detail,
              disappeared: before === null ? [] : difference(before, after),
              id: actionId,
              kind: described.kind,
              outcome: "succeeded",
              target:
                target === undefined
                  ? null
                  : {
                      checked: null,
                      context: [current.summary.selection.environment.bundleId],
                      disabled: null,
                      name: target.name,
                      role: target.role,
                      value:
                        gesture._tag === "type" && !target.password
                          ? gesture.text
                          : null,
                      valueWithheld:
                        gesture._tag === "type" && target.password
                          ? true
                          : null,
                    },
              targetInferred: inferred,
            });
            yield* keyframe(session, after, actionId);
          } else if (current.summary.kind !== "teaching") {
            yield* io(
              fs.writeFileString(
                path.join(session.directory, "actions.jsonl"),
                `${JSON.stringify({ action: described.kind, actionId, after: after.id, at: now(), before: before?.id ?? null, controller: "user", description: described.description, detail: described.detail, forwarded: true, targetInferred: inferred })}\n`,
                { flag: "a", mode: 0o600 }
              )
            );
            yield* keyframe(session, after, actionId);
          }
        });
      const recordGestures = (
        session: Session,
        gestures: readonly PendingGesture<IosObservation, IosNode>[],
        after: IosObservation
      ) =>
        Effect.forEach(
          gestures,
          (pending) => recordGesture(session, pending, after),
          { discard: true }
        );
      /** Names Forwarded Input that reached the device unobserved. */
      const markUnverified = (session: Session) =>
        update(session, (current) => ({
          ...current,
          summary: {
            ...current.summary,
            captureGaps: current.summary.captureGaps.includes(
              "forwarded_input_unverified"
            )
              ? current.summary.captureGaps
              : [...current.summary.captureGaps, "forwarded_input_unverified"],
          },
        }));
      /** Pauses, naming the Forwarded Input no observation has checked. */
      const pauseForwarded = (session: Session, cause: IosWorkspaceError) =>
        Effect.gen(function* pauseUnverified() {
          const unverified = session.lane.unobserved();
          session.lane.discard();
          yield* pause(session, cause).pipe(Effect.ignore);
          if (unverified > 0) {
            markUnverified(session);
            yield* persist(session).pipe(Effect.ignore);
          }
        });
      /**
       * Observes the result of the user's quiet input and records it. An
       * observation that later input overtook is stale and is discarded, so
       * the lane tries again. It reports failures by pausing the session.
       */
      const settleForwarded = (session: Session): Effect.Effect<boolean> =>
        session.lock.withPermits(1)(
          Effect.gen(function* settleForwardedInput() {
            const { summary } = state(session);
            if (summary.phase !== "running" || summary.controller !== "user") {
              session.lane.discard();
              return true;
            }
            const bound = state(session);
            if (bound.field?.password === true && bound.observation !== null) {
              // A tapped password field's Variable entry is bound to the
              // observation it was tapped on. Observing again, as the keyboard
              // opens, would make that entry stale, so its gestures are
              // recorded against the bound observation until the user leaves
              // the field.
              yield* recordGestures(
                session,
                session.lane.take(),
                bound.observation
              );
              yield* persist(session);
              return true;
            }
            const started = session.lane.observing();
            const observed = yield* session.run.mirror();
            if (!session.lane.current(started)) {
              return false;
            }
            const gestures = session.lane.take();
            acceptObservation(session, observed, { started });
            yield* recordGestures(session, gestures, observed);
            yield* persist(session);
            return true;
          }).pipe(
            Effect.result,
            // Paused before the lock is released, so no command sees the
            // session between the failure and its pause.
            Effect.flatMap((settled) =>
              Result.isSuccess(settled)
                ? Effect.succeed(settled.success)
                : pauseForwarded(session, settled.failure).pipe(Effect.as(true))
            )
          )
        );
      const forwardWorkspace = (
        session: Session,
        inputs: NativeForward["inputs"],
        source: "agent" | "user"
      ) =>
        Effect.gen(function* forwardWorkspaceInput() {
          const { summary } = state(session);
          if (
            source !== "user" ||
            summary.controller !== "user" ||
            summary.phase !== "running"
          ) {
            return yield* denied(
              "Only the user controlling a running session can send input. Nothing was sent."
            );
          }
          yield* session.lane.forward(inputs);
          yield* session.lane.wake(session.scope, settleForwarded(session));
        });
      /**
       * A Clear Flow's recording starts where every later Run starts: the
       * Target App's data is cleared and the app relaunched right before
       * Start, so setup changes to it are not recorded (ADR 0081).
       */
      const restartForRecording = (session: Session) =>
        Effect.gen(function* restartClearedApp() {
          if (startingDataOf(session.run.state().setup) !== "clear") {
            return;
          }
          const restarted = yield* session.run.restart();
          acceptObservation(session, restarted);
          update(session, (value) => ({
            ...value,
            startingObservation: boundaryObservationSummary(restarted),
          }));
        });
      const recordWorkspace = (
        session: Session,
        command: Extract<IosWorkspaceCommand, { readonly _tag: "record" }>,
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
            yield* restartForRecording(session);
            if (!(yield* session.stream.begin())) {
              return yield* denied("The iOS mirror is not ready for capture.");
            }
            yield* store.start({
              emulation: null,
              operationId: command.operationId,
              recordingId: summary.recordingId,
            });
            update(session, (value) => ({ ...value, recording: true }));
            // Start completes once the device's recorder runs; setup before
            // it is never recorded.
            yield* session.video.begin;
            yield* emit(session, {
              _tag: "started",
              emulation: null,
              observation: state(session).startingObservation ?? undefined,
              url: "",
            });
            const observed = yield* session.run.observe();
            acceptObservation(session, observed);
            yield* keyframe(session, observed, null);
          } else {
            const started = session.lane.observing();
            const gestures = session.lane.take();
            const observed = yield* session.run.observe();
            acceptObservation(session, observed, { started });
            yield* recordGestures(session, gestures, observed);
            if (!session.lane.current(started)) {
              // Input that arrived during the final observation reached the
              // device, but nothing shows its result.
              session.lane.discard();
              markUnverified(session);
            }
            yield* finishRecording(
              session,
              command.operationId,
              undefined,
              boundaryObservationSummary(observed)
            );
          }
        });
      const inputWorkspace = (
        session: Session,
        command: Extract<IosWorkspaceCommand, { readonly _tag: "input" }>,
        source: "agent" | "user",
        fresh?: IosObservation,
        approved = false
      ) =>
        // oxlint-disable-next-line eslint/complexity
        Effect.gen(function* inputWorkspaceCommand() {
          yield* session.stream.start();
          const current = state(session);
          const { summary } = current;
          if (summary.controller !== source || summary.phase !== "running") {
            return yield* denied(
              "Only the current controller can forward iOS input. Agent tools are disabled during Takeover."
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
                ? approved || current.observation?.id === command.observationId
                : current.field?.observationId === command.observationId &&
                  current.field.target === action.target;
            if (!bound) {
              return yield* denied(
                "This field observation is stale. Observe or pick the field again; no input was sent."
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
              ((action._tag === "fill" || action._tag === "variable") &&
                !selectedTarget.editable) ||
              selectedTarget.covered)
          ) {
            return yield* denied(
              "Select an uncovered semantic target, or an editable field for a fill."
            );
          }
          if (source === "agent") {
            const check = yield* checkNativeAppConfirmation(
              session.boundary,
              "ios",
              command,
              summary.flowName,
              selectedTarget
            );
            if (check !== undefined) {
              if (check.created) {
                update(session, (value) => ({
                  ...value,
                  pendingInput: structuredClone(command),
                }));
              }
              return;
            }
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
          const matches =
            selectedTarget === undefined
              ? []
              : before.nodes.filter(
                  (node) =>
                    node.role === selectedTarget.role &&
                    node.name === selectedTarget.name &&
                    node.editable === selectedTarget.editable &&
                    node.password === selectedTarget.password &&
                    (action._tag !== "variable" ||
                      (node.editable &&
                        JSON.stringify(node.bounds) ===
                          JSON.stringify(selectedTarget.bounds) &&
                        semanticSignature(before.nodes) ===
                          semanticSignature(selectedObservation.nodes))) &&
                    !node.covered &&
                    node.packageName === selectedTarget.packageName
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
          const actionId = `ios-action-${randomUUID()}`;
          update(session, (value) => ({
            ...value,
            field: null,
            observation: null,
          }));
          let fillResult: PlatformFillResult | undefined;
          if (action._tag === "variable") {
            fillResult = yield* session.run.enterVariable(before.id, {
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
            const dispatched = yield* session.run.dispatch(
              before.id,
              action._tag === "fill"
                ? {
                    target: target?.target ?? "",
                    text: action.text,
                    type: "fill",
                  }
                : { target: target?.target ?? "", type: "activate" }
            );
            fillResult = dispatched || undefined;
          }
          const after = yield* observeIosPostAction(
            session.run.observe(),
            before
          );
          acceptObservation(session, after);
          if (current.recording) {
            yield* keyframe(session, before, actionId);
            let enteredValue: string | null = null;
            if (action._tag === "fill") {
              enteredValue = action.text;
            }
            if (action._tag === "variable" && variable?.value !== undefined) {
              enteredValue = Redacted.value(variable.value);
            }
            yield* emit(session, {
              _tag: "action",
              actor: "user",
              after: observationSummary(after),
              appeared: difference(after, before),
              before: observationSummary(before),
              ...actionDescription(action, target, enteredValue),
              disappeared: difference(before, after),
              id: actionId,
              inputConfirmation: fillResult?.confirmation,
              kind: action._tag,
              outcome: "succeeded",
              target:
                target === undefined
                  ? null
                  : {
                      checked: null,
                      context: [summary.selection.environment.bundleId],
                      disabled: null,
                      name: target.name,
                      role: target.role,
                      value: enteredValue,
                      valueWithheld: null,
                    },
              variableName:
                action._tag === "variable" ? action.name : undefined,
            });
            yield* keyframe(session, after, actionId);
          } else if (summary.kind !== "teaching") {
            yield* io(
              fs.writeFileString(
                path.join(session.directory, "actions.jsonl"),
                `${JSON.stringify({ action: action._tag, actionId, after: after.id, at: now(), before: before.id, controller: source, inputConfirmation: fillResult?.confirmation, value: variable?.value === undefined ? undefined : Redacted.value(variable.value), variable: action._tag === "variable" ? action.name : undefined })}\n`,
                { flag: "a", mode: 0o600 }
              )
            );
            yield* keyframe(session, after, actionId);
          }
        });
      const completeWorkspace = (
        session: Session,
        command: Extract<IosWorkspaceCommand, { readonly _tag: "complete" }>,
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
          const secure = false;
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
          yield* endVideo(session);
          yield* session.stream.close();
          yield* session.run.close();
          yield* Scope.close(session.scope, Exit.void);
          yield* persist(session);
          yield* writeRunSummary(session, "completed");
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
        command: Exclude<IosWorkspaceCommand, { readonly _tag: "start" }>,
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
            const decided = yield* decideFlow({
              ...command,
              recordingId: summary.recordingId,
            }).pipe(Effect.provideService(TeachingRecordingStore, store));
            if (decided.cleanup._tag === "purged") {
              for (const owned of sessions.values()) {
                if (state(owned).summary.recordingId === summary.recordingId) {
                  // The files are gone; what they were stays, so a Run
                  // Summary can say cleanup deleted them.
                  update(owned, (value) => ({
                    ...value,
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
            yield* close(
              session,
              source === "user" ? "user-closed" : "interrupted"
            );
            return yield* snapshot(session);
          }
          if (terminal) {
            return yield* denied(
              "This iOS session has ended. Open a new prepared session."
            );
          }
          if (command._tag === "variable-request") {
            const setup =
              summary.kind === "teaching" &&
              summary.controller === "agent" &&
              current.sequence === 0;
            if (
              (summary.kind === "teaching" &&
                !setup &&
                !(source === "user" && current.recording)) ||
              (setup && source !== "agent")
            ) {
              return yield* denied(
                "Request Variables during agent-held setup, user-led recording, or a Run with input enabled."
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
                "Select a declared Flow input; Teaching supports at most 64 Variables."
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
                "Only Workspace can answer the current Variable request."
              );
            }
            registry.set(
              session.variables,
              variables.map((entry): WorkspaceVariable => {
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
            const pending = session.boundary.pending();
            if (
              pending !== undefined &&
              pending.decision.pendingDecisionId === command.decisionId
            ) {
              yield* session.boundary
                .resolve(
                  {
                    decision: command.allow ? "allow" : "refuse",
                    operationId: command.operationId,
                    pendingDecisionId: pending.decision.pendingDecisionId,
                  },
                  summary.controller !== "agent"
                )
                .pipe(
                  Effect.mapError((cause) =>
                    error("ios_session_invalid", cause.message)
                  )
                );
              const attempt = state(session).pendingInput;
              update(session, (value) => ({ ...value, pendingInput: null }));
              if (command.allow && attempt !== null) {
                yield* session.video.action(
                  inputWorkspace(session, attempt, "agent", undefined, true)
                );
              }
              yield* persist(session);
              return yield* snapshot(session, source === "user");
            }
            if (
              source !== "user" &&
              !relayedDecisionAllowed(session.run.state(), command.decisionId)
            ) {
              return yield* denied(
                "Run Environment Permission requires an explicit Workspace choice."
              );
            }
            yield* session.run.decide(command.decisionId, command.allow);
            if (!command.allow) {
              // Nothing ran and nothing will: release the device now, and
              // leave a refused Dry Run's recording ready for another attempt.
              yield* failActiveDryRun(
                session,
                "The user refused a preparation decision before the Dry Run started."
              );
              clearVariables(session);
              yield* session.stream.close();
              yield* session.run.close();
              yield* Scope.close(session.scope, Exit.void);
              update(session, (value) => ({
                ...value,
                observation: null,
                observations: [],
                summary: {
                  ...value.summary,
                  completedAt: value.summary.completedAt ?? now(),
                  phase: "refused",
                },
              }));
            }
          } else if (command._tag === "prepare") {
            if (source !== "user") {
              return yield* denied(
                "Preparation requires the user's Workspace action."
              );
            }
            const prepared = yield* session.run.prepare();
            acceptObservation(session, prepared);
            update(session, (value) => ({
              ...value,
              startingObservation: boundaryObservationSummary(prepared),
            }));
            yield* session.stream.start();
            if (summary.kind !== "teaching") {
              yield* session.video.begin;
            }
          } else if (
            command._tag === "recover" ||
            command._tag === "return-to-target-app"
          ) {
            if (source !== "user") {
              return yield* denied(
                "Recovery requires an explicit same-device Workspace action."
              );
            }
            if (
              (command._tag === "return-to-target-app") !==
              (summary.refusal?.code === "foreign_app_foreground")
            ) {
              return yield* denied(
                "Use the recovery attached to this session's refusal."
              );
            }
            acceptObservation(
              session,
              yield* session.run.state().phase === "ready"
                ? session.run.observe()
                : session.run.recover()
            );
            // Returning an app does not replace the framebuffer source. Keep the
            // active Teaching interval intact; only transport recovery restarts it.
            if (command._tag === "recover") {
              yield* session.stream.recover();
            }
          } else if (command._tag === "observe") {
            if (
              summary.phase === "paused" &&
              summary.refusal?.code === "foreign_app_foreground"
            ) {
              return yield* Effect.fail(
                platformRuntimeError("foreign_app_foreground")
              );
            }
            if (summary.phase !== "running") {
              return yield* denied(
                "Prepare or explicitly recover this selected device first."
              );
            }
            // Retain the selected field while the user supplies its Variable.
            if (source === "user" && current.field?.password === true) {
              return yield* snapshot(session, command.image);
            }
            if (source === "agent") {
              acceptObservation(session, yield* session.run.observe());
            } else if (summary.controller === "user") {
              // Forwarded Input that overtakes this observation makes it stale.
              const started = session.lane.observing();
              const mirrored = yield* session.run.mirror();
              if (session.lane.current(started)) {
                const gestures = session.lane.take();
                acceptObservation(session, mirrored);
                yield* recordGestures(session, gestures, mirrored);
              }
            }
            return yield* snapshot(session, command.image && source === "user");
          } else if (command._tag === "control") {
            if (source !== "user" || summary.kind === "teaching") {
              return yield* denied(
                "Run control changes require Workspace. Teaching remains user-led."
              );
            }
            const gestures = session.lane.take();
            const { takeoverFrom } = session.marks;
            if (command.controller === "user") {
              session.marks.takeoverFrom ??= Date.now();
            } else if (takeoverFrom !== undefined) {
              session.marks.takeoverFrom = undefined;
              yield* session.video.takeover(takeoverFrom);
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
            const controlled = yield* session.run.observe();
            acceptObservation(session, controlled);
            yield* recordGestures(session, gestures, controlled);
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
            // An agent action plays at real speed in the condensed video.
            yield* source === "agent"
              ? session.video.action(inputWorkspace(session, command, source))
              : inputWorkspace(session, command, source);
          } else if (command._tag === "complete") {
            yield* completeWorkspace(session, command, source);
          }
          yield* persist(session);
          return yield* snapshot(session, source === "user");
        });

      const readPersisted = (id: AgentSessionId) =>
        io(
          fs.readFileString(
            path.join(options.root(), ".ios-workspace", `${id}.json`)
          )
        ).pipe(
          Effect.flatMap((contents) =>
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(IosWorkspaceSummary)
            )(contents)
          ),
          Effect.mapError(() =>
            error(
              "ios_session_not_found",
              "No valid persisted iOS summary exists for this session."
            )
          )
        );
      const snapshotPersisted = (
        summary: IosWorkspaceSummary
      ): Effect.Effect<IosWorkspaceSnapshot, IosWorkspaceError> =>
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
      return IosWorkspace.of({
        activeRunFlowNames: () =>
          Effect.sync(() => {
            const names: string[] = [];
            for (const session of sessions.values()) {
              const { summary } = state(session);
              if (
                summary.kind !== "teaching" &&
                ["pending", "running", "paused"].includes(summary.phase)
              ) {
                names.push(summary.flowName);
              }
            }
            return names;
          }),
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
                    "This process does not own the iOS session. Reopen its persisted Summary or start a new session."
                  );
                }
                const summary = yield* readPersisted(command.sessionId);
                if (command._tag === "flow-decision") {
                  if (source !== "user" || summary.recordingId === null) {
                    return yield* denied(
                      "Verification and Cleanup require an explicit Workspace choice for its recording."
                    );
                  }
                  yield* decideFlow({
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
                      "This operationId already names another iOS attempt."
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
                    cause.code === "ios_workspace_refused"
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
        forward: ({ inputs, sessionId }, source) =>
          Effect.suspend(() => {
            const session = sessions.get(sessionId);
            // Input never waits behind an observation. It is not replayable,
            // so it carries no receipt.
            return session === undefined
              ? denied(
                  "This process does not own the iOS session. Nothing was sent."
                )
              : forwardWorkspace(session, inputs, source);
          }),
        keyframes: (sessionId) => {
          const session = sessions.get(sessionId);
          if (session !== undefined) {
            return Effect.succeed({
              directory: session.directory,
              keyframes: state(session).artifacts.filter(
                (artifact) => artifact.kind === "keyframe"
              ),
            });
          }
          // A session from before this process: its persisted index.
          return fs
            .readFileString(
              keyframeIndexFile(
                path.join(options.root(), ".ios-workspace", `${sessionId}.json`)
              )
            )
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(KeyframeIndex)),
              Effect.orElseSucceed(() => null)
            );
        },
        // Only sessions this process owns and the user can continue. An ended
        // session stays readable by id; what it produced lasts as its Teaching
        // Recording or Run.
        list: () =>
          Effect.sync(() =>
            [...sessions.values()].flatMap((session) => {
              const { summary } = state(session);
              return summary.phase === "pending" ||
                summary.phase === "running" ||
                summary.phase === "paused"
                ? [summary]
                : [];
            })
          ),
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
        video: (sessionId) =>
          Effect.gen(function* locateVideo() {
            const session = sessions.get(sessionId);
            let directory = session?.directory;
            let recordingId =
              session === undefined ? null : state(session).summary.recordingId;
            if (session === undefined) {
              // A session from before this process: its summary names its
              // recording, and its keyframe index names its folder.
              const persisted = yield* readPersisted(sessionId).pipe(
                Effect.option
              );
              const index = yield* fs
                .readFileString(
                  keyframeIndexFile(
                    path.join(
                      options.root(),
                      ".ios-workspace",
                      `${sessionId}.json`
                    )
                  )
                )
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(KeyframeIndex)),
                  Effect.option
                );
              if (Option.isNone(persisted) || Option.isNone(index)) {
                return null;
              }
              ({ recordingId } = persisted.value);
              ({ directory } = index.value);
            }
            if (directory === undefined) {
              return null;
            }
            const purged =
              recordingId !== null &&
              (yield* store.read(recordingId).pipe(
                Effect.map(({ cleanup }) => cleanup._tag === "purged"),
                Effect.orElseSucceed(() => false)
              ));
            return {
              folder: path.join(directory, DEVICE_VIDEO_DIRECTORY),
              live: session?.video.live() ?? false,
              purged,
            };
          }),
      });
    })
  );
