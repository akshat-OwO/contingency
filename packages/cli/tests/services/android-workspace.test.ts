import path from "node:path";
import { Readable } from "node:stream";

import {
  AgentSessionId,
  AndroidWorkspaceCommand,
  CatalogRunSummary,
  AndroidWorkspaceSnapshot,
  FlowName,
  NativeForward,
  OperationId,
  TeachingEvent,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceSelection,
  NativeInput,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type { Mutable } from "effect/Types";

import { createAndroidRun } from "../../src/services/android-run.ts";
import type {
  AndroidRuntimeBackend,
  AndroidObservation,
} from "../../src/services/android-runtime-contract.ts";
import { adaptAndroidRuntime } from "../../src/services/android-runtime.ts";
import type { acquireAndroidStream } from "../../src/services/android-stream.ts";
import {
  AndroidWorkspace,
  makeAndroidWorkspaceLayer,
} from "../../src/services/android-workspace.ts";
import type { AndroidWorkspaceService } from "../../src/services/android-workspace.ts";
import {
  DEVICE_VIDEO_DIRECTORY,
  readDeviceCapture,
} from "../../src/services/device-video-capture.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import {
  DeviceWorkspaceTools,
  DeviceWorkspaceToolHandlersLive,
} from "../../src/services/mcp-device-workspace.ts";
import { OBSERVATION_VALIDATION_MILLIS } from "../../src/services/native-app-runtime.ts";
import { SETTLE_MILLIS } from "../../src/services/native-forwarded-lane.ts";
import type { NativeScreenRecorder } from "../../src/services/native-screen-recorder.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import { PlatformRuntimeFactory } from "../../src/services/platform-runtime.ts";
import {
  makeTargetAppBuilds,
  TargetAppBuilds,
} from "../../src/services/target-app-builds.ts";
import type { TargetAppBuildsService } from "../../src/services/target-app-builds.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import type { TeachingRecordingLearningService } from "../../src/services/teaching-recording-learning.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import type { TeachingRecordingStoreService } from "../../src/services/teaching-recording-store.ts";

const selection: AndroidWorkspaceSelection = {
  device: {
    api: 36,
    avd: "fixture",
    fingerprint: "fixture",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "2",
    appId: "dev.fixture",
    startingState: "Home",
  },
  helperConsent: "none",
  outcomes: [{ name: "Home", role: "text" }],
  setup: {
    activity: "dev.fixture/.Home",
    conditions: [{ name: "Home", role: "text" }],
    kind: "restart-activity",
  },
};
const op = OperationId.make;
const flowName = FlowName.make("android-edit");
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqz8AAAAASUVORK5CYII=";
const flow = `---\nname: android-edit\ndescription: Edit a public fixture field and return Home. Use when testing the Android fixture.\ninputs:\n---\n\n# Edit the fixture\n\n1. Activate the button named Edit. Done when: the public field is visible.\n2. Enter public fixture text. Done when: the field shows the value.\n3. Go back. Done when: Home is visible.\n`;

interface CaptureGate {
  readonly entered: Deferred.Deferred<boolean>;
  readonly release: Deferred.Deferred<boolean>;
}
const fixture = (
  test: (input: {
    readonly root: string;
    readonly calls: string[];
    readonly resolved: string[];
    readonly secure: () => void;
    readonly disconnect: () => void;
    readonly reconnect: () => void;
    readonly setNodes: (nodes: AndroidObservation["nodes"]) => void;
    /** Forwarded Input batches the device stream received, in order. */
    readonly forwarded: NativeInput[][];
    /**
     * Holds the next capture after it starts until the test releases it.
     * Releasing with `false` fails that capture as a lost device.
     */
    readonly holdNextCapture: () => Effect.Effect<CaptureGate>;
    /** Uploaded Target App builds the workspace can claim. */
    readonly builds: TargetAppBuildsService;
    /** The device recorder's starts and stops, in order. */
    readonly recorded: string[];
    /** A fresh workspace over the same root, as after a process restart. */
    readonly restart: () => Effect.Effect<
      AndroidWorkspaceService,
      never,
      Scope.Scope
    >;
  }) => Effect.Effect<
    void,
    unknown,
    | AndroidWorkspaceService
    | TeachingRecordingStoreService
    | TeachingRecordingLearningService
    | FileSystem.FileSystem
  >
) =>
  Effect.scoped(
    Effect.gen(function* workspaceFixture() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "android-workspace-test-",
      });
      const calls: string[] = [];
      const resolved: string[] = [];
      const forwarded: NativeInput[][] = [];
      const recorded: string[] = [];
      let recordingFile: string | undefined;
      // The display and input transport, without a device.
      const acquireStream: typeof acquireAndroidStream = () =>
        Effect.succeed({
          access: { path: "/android/stream/fixture", token: "fixture" },
          authorized: () => false,
          forward: (inputs) =>
            Effect.sync(() => {
              forwarded.push([...inputs]);
            }),
          frames: Stream.empty,
          packets: Stream.empty,
        });
      // The session's screen recorder: it leaves a footage file where it
      // was asked to record.
      const screenRecorder: NativeScreenRecorder = {
        footageBytes: Effect.succeed(0),
        start: (file) =>
          Effect.sync(() => {
            recorded.push("start");
            recordingFile = file;
            return Date.now();
          }),
        stop: () =>
          Effect.gen(function* stopFixtureRecorder() {
            recorded.push("stop");
            const file = recordingFile ?? "";
            yield* fs.writeFile(file, new Uint8Array(8)).pipe(Effect.orDie);
            return {
              capturedDurationMs: undefined,
              devicePath: undefined,
              durationMs: 0,
              files: [file],
              hidden: [],
              recorder: "confirmed" as const,
              restarts: [],
              starts: [0],
              warning: undefined,
            };
          }),
      };
      let secure = false;
      let connected = true;
      let generation = 0;
      let held: CaptureGate | undefined;
      let customNodes: AndroidObservation["nodes"] | undefined;
      let boundNodes: AndroidObservation["nodes"] | undefined;
      const backend: AndroidRuntimeBackend = {
        activate: () =>
          Effect.sync(() => {
            calls.push("activate");
          }),
        back: () =>
          Effect.sync(() => {
            calls.push("back");
          }),
        capture: () =>
          Effect.suspend(() => {
            const gate = held;
            held = undefined;
            return gate === undefined
              ? Effect.void
              : Deferred.succeed(gate.entered, true).pipe(
                  Effect.andThen(Deferred.await(gate.release)),
                  Effect.flatMap((completed) =>
                    completed
                      ? Effect.void
                      : Effect.fail(platformRuntimeError("device_disconnected"))
                  )
                );
          }).pipe(
            Effect.map((): AndroidObservation => {
              generation += 1;
              boundNodes = customNodes;
              return {
                backendSessionId: "fixture-session",
                capture: {
                  complete: true,
                  mode: "interactive-windows",
                  secureWindowVisibility: "unverified",
                  windowCount: 1,
                },
                device: selection.device,
                generation,
                id: `observation-${generation}`,
                nodes: customNodes ?? [
                  {
                    covered: false,
                    editable: false,
                    hittable: true,
                    name: "Home",
                    packageName: "dev.fixture",
                    password: false,
                    role: "text",
                    target: "@e1",
                  },
                  {
                    bounds: { height: 1, width: 1, x: 0, y: 0 },
                    covered: false,
                    editable: false,
                    hittable: true,
                    name: "Edit",
                    packageName: "dev.fixture",
                    password: false,
                    role: "button",
                    target: "@e2",
                  },
                ],
                ownership: {
                  focusedPackage: "dev.fixture",
                  kind: "experimental-host-check",
                  systemDialogAuthority: "unsupported",
                },
                platform: "android",
                screenshot: {
                  capturedAt: "2026-10-13T00:00:00.000Z",
                  encoding: "base64",
                  format: "png",
                  image,
                },
              };
            })
          ),
        close: () => Effect.void,
        fill: (_target, text) =>
          Effect.suspend(() => {
            if (JSON.stringify(boundNodes) !== JSON.stringify(customNodes)) {
              return Effect.fail(platformRuntimeError("target_changed"));
            }
            return Effect.sync(() => {
              resolved.push(text);
              calls.push(
                customNodes?.some((node) => node.password) ? "private" : "fill"
              );
              return {
                confirmation: "unconfirmed" as const,
                outcome: "entered" as const,
              };
            });
          }),
        recover: () => Effect.void,
        sessionId: "fixture-session",
        validate: () => {
          if (secure) {
            return Effect.fail(platformRuntimeError("secure_window"));
          }
          return connected
            ? Effect.void
            : Effect.fail(platformRuntimeError("device_disconnected"));
        },
      };
      const factory = Layer.succeed(
        PlatformRuntimeFactory,
        PlatformRuntimeFactory.of({
          android: {
            capabilities: ["semantic-actions", "screenshots", "private-input"],
            createRun: (input) =>
              createAndroidRun(input, {
                installedBuild: () => Effect.succeed("1"),
                preflight: () => Effect.void,
                start: (startup) => adaptAndroidRuntime({ backend, startup }),
              }),
            platform: "android",
            start: () => Effect.die("Attach-only runtime must not be used."),
          },
          start: () => Effect.die("Generic runtime must not be used."),
          web: {
            capabilities: [],
            platform: "web",
            start: () => Effect.die("Browser runtime must not be used."),
          },
        })
      );
      const store = makeTeachingRecordingStoreLayer({ root: () => root });
      const builds = yield* makeTargetAppBuilds({
        badging: () =>
          Effect.succeed(
            "package: name='dev.fixture' versionCode='2' versionName='2'\nlaunchable-activity: name='dev.fixture.Home'  label='' icon=''"
          ),
        plist: () => Effect.die("No iOS builds in the Android fixture."),
      });
      const dependencies = Layer.mergeAll(
        store,
        makeFlowCatalogLayer({ root }),
        factory,
        Layer.succeed(TargetAppBuilds, builds)
      );
      const workspace = makeAndroidWorkspaceLayer({
        acquireStream,
        root: () => root,
        screenRecorder: () => screenRecorder,
      }).pipe(Layer.provide(dependencies));
      const learning = TeachingRecordingLearningLive.pipe(Layer.provide(store));
      // Without the test's own Scope, so a restarted workspace lives only as
      // long as the scope that builds it, as a process that exits.
      const services = Context.omit(Scope.Scope)(
        yield* Effect.context<FileSystem.FileSystem>()
      );
      const restart = () =>
        Layer.build(
          makeAndroidWorkspaceLayer({
            acquireStream,
            root: () => root,
            screenRecorder: () => screenRecorder,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                makeTeachingRecordingStoreLayer({ root: () => root }),
                makeFlowCatalogLayer({ root }),
                factory
              )
            )
          )
        ).pipe(
          Effect.map((context) => Context.get(context, AndroidWorkspace)),
          Effect.provide(services),
          Effect.orDie
        );
      yield* test({
        builds,
        calls,
        disconnect: () => {
          connected = false;
        },
        forwarded,
        holdNextCapture: () =>
          Effect.gen(function* holdCapture() {
            const gate = {
              entered: yield* Deferred.make<boolean>(),
              release: yield* Deferred.make<boolean>(),
            };
            held = gate;
            return gate;
          }),
        reconnect: () => {
          connected = true;
        },
        recorded,
        resolved,
        restart,
        root,
        secure: () => {
          secure = true;
        },
        setNodes: (nodes) => {
          customNodes = nodes;
        },
      }).pipe(Effect.provide(Layer.mergeAll(workspace, store, learning)));
    })
  ).pipe(Effect.provide(NodeServices.layer));

const teach = (optional = false) =>
  Effect.gen(function* recordAndLearn() {
    const workspace = yield* AndroidWorkspace;
    const started = yield* workspace.execute(
      {
        _tag: "start",
        flowName,
        kind: "teaching",
        operationId: op("start-teaching"),
        recordingId: null,
        selection: optional
          ? {
              ...selection,
              outcomes: [],
              setup: { ...selection.setup, conditions: [] },
            }
          : selection,
      },
      "user"
    );
    expect(started.observation).toBeNull();
    yield* workspace.execute(
      {
        _tag: "prepare",
        operationId: op("prepare-teaching"),
        sessionId: started.id,
      },
      "user"
    );
    yield* workspace.execute(
      {
        _tag: "record",
        operationId: op("record-start"),
        sessionId: started.id,
        start: true,
      },
      "user"
    );
    const observed = yield* workspace.execute(
      { _tag: "observe", image: false, sessionId: started.id },
      "agent"
    );
    expect(
      observed.observation?.nodes.find((node) => node.name === "Edit")?.bounds
    ).toEqual({ height: 1, width: 1, x: 0, y: 0 });
    yield* workspace.execute(
      {
        _tag: "input",
        action: { _tag: "activate", target: "@e2" },
        observationId: observed.observation?.id ?? "",
        operationId: op("teach-input"),
        sessionId: started.id,
      },
      "user"
    );
    yield* workspace.execute(
      {
        _tag: "instruction",
        operationId: op("instruction"),
        sessionId: started.id,
        text: "Return to Home; use only public fixture text.",
      },
      "user"
    );
    const stopped = yield* workspace.execute(
      {
        _tag: "record",
        operationId: op("record-stop"),
        sessionId: started.id,
        start: false,
      },
      "user"
    );
    expect(stopped.captureState?._tag).toBe("ready");
    if (stopped.recordingId === null) {
      return yield* Effect.die("Recording missing.");
    }
    yield* workspace.execute(
      {
        _tag: "close",
        operationId: op("close-teaching"),
        sessionId: started.id,
      },
      "user"
    );
    const store = yield* TeachingRecordingStore;
    yield* store.startLearning({
      operationId: op("claim"),
      recordingId: stopped.recordingId,
    });
    const learning = yield* TeachingRecordingLearning;
    const timeline = yield* learning.timeline({
      claimOperationId: op("claim"),
      cursor: 0,
      recordingId: stopped.recordingId,
    });
    expect(JSON.stringify(timeline)).toContain("Activate button Edit");
    if (optional) {
      const refused = yield* Effect.flip(
        learning.save({
          claimOperationId: op("claim"),
          files: [{ content: flow, path: "flow.md" }],
          nativeConditions: {
            outcomes: [{ name: "Home", role: "text" }],
            starting: [{ name: "Invented", role: "text" }],
          },
          operationId: op("invalid-save"),
          recordingId: stopped.recordingId,
        })
      );
      expect(refused.message).toContain("observed after launch");
    }
    yield* learning.save({
      claimOperationId: op("claim"),
      files: [{ content: flow, path: "flow.md" }],
      nativeConditions: {
        outcomes: [{ name: "Home", role: "text" }],
        starting: [{ name: "Home", role: "text" }],
      },
      operationId: op("save"),
      recordingId: stopped.recordingId,
    });
    if (optional) {
      yield* learning.save({
        claimOperationId: op("claim"),
        files: [{ content: flow, path: "flow.md" }],
        nativeConditions: {
          outcomes: [{ name: "Home", role: "text" }],
          starting: [{ name: "Edit", role: "button" }],
        },
        operationId: op("correct-starting"),
        recordingId: stopped.recordingId,
      });
      expect((yield* store.read(stopped.recordingId)).runtime).toMatchObject({
        preparation: { conditions: [{ name: "Edit", role: "button" }] },
      });
      yield* learning.save({
        claimOperationId: op("claim"),
        files: [{ content: flow, path: "flow.md" }],
        nativeConditions: {
          outcomes: [{ name: "Home", role: "text" }],
          starting: [{ name: "Home", role: "text" }],
        },
        operationId: op("restore-starting"),
        recordingId: stopped.recordingId,
      });
    }
    return stopped.recordingId;
  });
const dryRun = (recordingId: TeachingRecordingId) =>
  Effect.gen(function* startDryRun() {
    const workspace = yield* AndroidWorkspace;
    const started = yield* workspace.execute(
      {
        _tag: "start",
        flowName,
        kind: "dry-run",
        operationId: op("start-dry"),
        recordingId,
        selection: {
          ...selection,
          setup: { ...selection.setup, conditions: [] },
        },
      },
      "agent"
    );
    return yield* workspace.execute(
      {
        _tag: "prepare",
        operationId: op("prepare-dry"),
        sessionId: started.id,
      },
      "user"
    );
  });

const runSummaryFile = (root: string, sessionId: string) =>
  path.join(
    root,
    "android-edit",
    "runs",
    `agentrun-${sessionId}`,
    "summary.json"
  );
const readRunSummary = (root: string, sessionId: string) =>
  Effect.gen(function* readNativeRunSummary() {
    const fs = yield* FileSystem.FileSystem;
    const file = runSummaryFile(root, sessionId);
    if (!(yield* fs.exists(file))) {
      return null;
    }
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CatalogRunSummary)
    )(yield* fs.readFileString(file));
  });

it.effect(
  "lists only the sessions this process owns and the user can continue",
  () =>
    fixture(({ restart, root }) =>
      Effect.gen(function* liveSessions() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: op("start-listed"),
            recordingId: null,
            selection,
          },
          "user"
        );
        expect((yield* workspace.list()).map(({ id }) => id)).toEqual([
          started.id,
        ]);
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare-listed"),
            sessionId: started.id,
          },
          "user"
        );
        expect((yield* workspace.list()).map(({ phase }) => phase)).toEqual([
          "running",
        ]);
        yield* workspace.execute(
          {
            _tag: "close",
            operationId: op("close-listed"),
            sessionId: started.id,
          },
          "user"
        );
        expect(yield* workspace.list()).toEqual([]);
        // The ended session stays readable by id.
        expect(
          (yield* workspace.execute(
            { _tag: "read", sessionId: started.id },
            "user"
          )).phase
        ).toBe("closed");

        // A record another process left running, and one that is corrupt,
        // are not sessions this process can continue.
        const fs = yield* FileSystem.FileSystem;
        const records = path.join(root, ".android-workspace");
        const record = yield* fs.readFileString(
          path.join(records, `${started.id}.json`)
        );
        const orphan = AgentSessionId.make(`agent-android-${"a".repeat(32)}`);
        yield* fs.writeFileString(
          path.join(records, `${orphan}.json`),
          JSON.stringify({
            ...JSON.parse(record),
            completedAt: null,
            id: orphan,
            phase: "running",
          })
        );
        yield* fs.writeFileString(
          path.join(records, `agent-android-${"b".repeat(32)}.json`),
          "{"
        );
        const [listed, reopened] = yield* Effect.scoped(
          Effect.flatMap(restart(), (fresh) =>
            Effect.all([
              fresh.list(),
              fresh.execute({ _tag: "read", sessionId: orphan }, "user"),
            ])
          )
        );
        expect(listed).toEqual([]);
        expect(reopened.phase).toBe("closed");
        // The record this process just read is its own again only by id.
        expect(yield* workspace.list()).toEqual([]);
      })
    )
);

it.effect(
  "native Runs and Dry Runs that ran end with a Run Summary under their Flow",
  () =>
    fixture(({ restart, root }) =>
      Effect.gen(function* nativeRunSummaries() {
        const recordingId = yield* teach();
        const workspace = yield* AndroidWorkspace;
        const dry = yield* dryRun(recordingId);
        expect(yield* readRunSummary(root, dry.id)).toBeNull();
        yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Home is visible.",
              observationId: dry.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("complete-summary-dry"),
            sessionId: dry.id,
          },
          "agent"
        );
        expect(yield* readRunSummary(root, dry.id)).toMatchObject({
          assessment: { outcome: "working" },
          flowName,
          kind: "dry-run",
          outcome: "completed",
          platform: "android",
          recordingId,
          runId: `agentrun-${dry.id}`,
          schemaVersion: 4,
          sessionId: dry.id,
        });
        expect(yield* workspace.list()).toEqual([]);
        yield* workspace.execute(
          {
            _tag: "flow-decision",
            decision: "verify",
            operationId: op("verify-summary"),
            sessionId: dry.id,
          },
          "user"
        );
        const startRun = (id: string) =>
          workspace.execute(
            {
              _tag: "start",
              flowName,
              kind: "run",
              operationId: op(id),
              recordingId: null,
              selection,
            },
            "agent"
          );
        const closeRun = (sessionId: AgentSessionId, id: string) =>
          workspace.execute(
            { _tag: "close", operationId: op(id), sessionId },
            "user"
          );

        // Closed before it was prepared: nothing ran, so no Run Summary.
        const unprepared = yield* startRun("start-unprepared");
        yield* closeRun(unprepared.id, "close-unprepared");
        expect(yield* readRunSummary(root, unprepared.id)).toBeNull();

        const closed = yield* startRun("start-closed");
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare-closed"),
            sessionId: closed.id,
          },
          "user"
        );
        yield* closeRun(closed.id, "close-closed");
        // Closing an ended session again keeps its outcome.
        yield* closeRun(closed.id, "close-closed-again");
        expect(yield* readRunSummary(root, closed.id)).toMatchObject({
          assessment: null,
          kind: "run",
          outcome: "user-closed",
          recordingId: null,
          title: "Android Run · android-edit",
        });
        expect(
          (yield* workspace.execute(
            { _tag: "read", sessionId: closed.id },
            "user"
          )).phase
        ).toBe("closed");

        // A process that exits mid-Run still leaves the Run's Summary.
        const exited = yield* Effect.scoped(
          Effect.gen(function* exitMidRun() {
            const fresh = yield* restart();
            const started = yield* fresh.execute(
              {
                _tag: "start",
                flowName,
                kind: "run",
                operationId: op("start-exited"),
                recordingId: null,
                selection,
              },
              "agent"
            );
            yield* fresh.execute(
              {
                _tag: "prepare",
                operationId: op("prepare-exited"),
                sessionId: started.id,
              },
              "user"
            );
            return started.id;
          })
        );
        expect(yield* readRunSummary(root, exited)).toMatchObject({
          kind: "run",
          outcome: "process-exited",
        });
      })
    )
);

it.effect(
  "records the device's screen from Teaching's Start to Stop and across a Run's execution",
  () =>
    fixture(({ recorded, root }) =>
      Effect.gen(function* deviceVideo() {
        const recordingId = yield* teach();
        // Teaching recorded from Start to Stop only.
        expect(recorded).toEqual(["start", "stop"]);
        const workspace = yield* AndroidWorkspace;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* TeachingRecordingStore;
        const teaching = yield* readDeviceCapture(
          path.join(store.directory(recordingId), DEVICE_VIDEO_DIRECTORY)
        );
        expect(teaching).toMatchObject({
          files: ["recording.mp4"],
          pacing: "real-time",
          platform: "android",
          state: "recorded",
        });
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("start-video-dry"),
            recordingId,
            selection: {
              ...selection,
              setup: { ...selection.setup, conditions: [] },
            },
          },
          "agent"
        );
        // Setup before the Run's execution is never recorded.
        expect(recorded).toEqual(["start", "stop"]);
        const dry = yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare-video-dry"),
            sessionId: started.id,
          },
          "user"
        );
        expect(recorded).toEqual(["start", "stop", "start"]);
        expect(yield* workspace.video(dry.id)).toMatchObject({ live: true });
        yield* workspace.execute(
          {
            _tag: "input",
            action: { _tag: "activate", target: "@e2" },
            observationId: dry.observation?.id ?? "",
            operationId: op("video-agent-input"),
            sessionId: dry.id,
          },
          "agent"
        );
        yield* workspace.execute(
          {
            _tag: "control",
            controller: "user",
            operationId: op("video-takeover"),
            sessionId: dry.id,
          },
          "user"
        );
        const returned = yield* workspace.execute(
          {
            _tag: "control",
            controller: "agent",
            operationId: op("video-return"),
            sessionId: dry.id,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Home is visible.",
              observationId: returned.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("complete-video-dry"),
            sessionId: dry.id,
          },
          "agent"
        );
        expect(recorded).toEqual(["start", "stop", "start", "stop"]);
        const located = yield* workspace.video(dry.id);
        expect(located).toEqual({
          folder: path.join(
            path.dirname(runSummaryFile(root, dry.id)),
            DEVICE_VIDEO_DIRECTORY
          ),
          live: false,
          purged: false,
        });
        const capture = yield* readDeviceCapture(located?.folder ?? "");
        expect(capture).toMatchObject({
          pacing: "condensed",
          state: "recorded",
        });
        expect(capture?.actions).toHaveLength(1);
        expect(capture?.takeovers).toHaveLength(1);
        expect(
          yield* fs.exists(path.join(located?.folder ?? "", "recording.mp4"))
        ).toBe(true);
        const summary = yield* readRunSummary(root, dry.id);
        expect(summary).toMatchObject({
          videoTimeMap: {
            fastForward: "capped",
            startedAt: new Date(capture?.startedAt ?? 0).toISOString(),
          },
        });
      })
    )
);

it.effect(
  "refusing a Dry Run's preparation leaves its recording ready for another attempt",
  () =>
    fixture(({ root }) =>
      Effect.gen(function* refusedDryRun() {
        const recordingId = yield* teach();
        const workspace = yield* AndroidWorkspace;
        const store = yield* TeachingRecordingStore;
        const startDry = (id: string, appBuild: string) =>
          workspace.execute(
            {
              _tag: "start",
              flowName,
              kind: "dry-run",
              operationId: op(id),
              recordingId,
              selection: {
                ...selection,
                environment: { ...selection.environment, appBuild },
                setup: { ...selection.setup, conditions: [] },
              },
            },
            "agent"
          );
        // A changed build asks for the user's Run Environment Permission.
        const changed = yield* startDry("start-dry-changed", "3");
        const [decision] = changed.preparation.pending;
        expect(decision?.kind).toBe("run-environment-permission");
        expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
          "dry-running"
        );
        const refused = yield* workspace.execute(
          {
            _tag: "decide",
            allow: false,
            decisionId: decision?.id ?? "",
            operationId: op("refuse-dry"),
            sessionId: changed.id,
          },
          "user"
        );
        expect(refused.phase).toBe("refused");
        expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
          "dry-run-failed"
        );
        expect(yield* workspace.list()).toEqual([]);
        expect(yield* readRunSummary(root, changed.id)).toBeNull();
        // Another Dry Run of the same recording can start.
        const retried = yield* startDry("start-dry-retry", "2");
        expect(retried.kind).toBe("dry-run");
        expect((yield* store.read(recordingId)).lifecycle._tag).toBe(
          "dry-running"
        );
      })
    )
);

it.effect(
  "installs an uploaded .apk only with consent, and deletes the upload when the session ends",
  () =>
    fixture(({ builds, calls }) =>
      Effect.gen(function* uploadedApk() {
        const workspace = yield* AndroidWorkspace;
        const start = (id: string, apkPath: string) =>
          workspace.execute(
            {
              _tag: "start",
              flowName,
              kind: "teaching",
              operationId: op(id),
              recordingId: null,
              selection: { ...selection, apkPath },
            },
            "user"
          );
        // A path the person typed is never installed.
        const typed = yield* start("start-typed", "/tmp/typed.apk").pipe(
          Effect.flip
        );
        expect(typed.message).toContain("no longer uploaded");
        const uploaded = yield* builds.receiveAndroid(
          Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])]),
          "fixture.apk"
        );
        const started = yield* start("start-uploaded", uploaded.apkPath);
        const [decision] = started.preparation.pending;
        expect(decision).toMatchObject({
          installedBuild: "1",
          kind: "app-installation",
          targetApp: "dev.fixture",
        });
        const refused = yield* workspace.execute(
          {
            _tag: "decide",
            allow: false,
            decisionId: decision?.id ?? "",
            operationId: op("refuse-install"),
            sessionId: started.id,
          },
          "user"
        );
        // Declining sends nothing to the device.
        expect(refused.preparation.phase).toBe("refused");
        expect(calls).toEqual([]);
        // Refusal ends the session and releases what it held, the upload too.
        expect(refused.phase).toBe("refused");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(uploaded.apkPath)).toBe(false);
        expect(yield* workspace.list()).toEqual([]);
        expect(yield* workspace.stream(started.id)).toBeNull();
        const closed = yield* workspace.execute(
          {
            _tag: "close",
            operationId: op("close-uploaded"),
            sessionId: started.id,
          },
          "user"
        );
        expect(closed.phase).toBe("refused");
      })
    )
);

it.effect("starts, reads, and lists Android through the device tools", () =>
  fixture(() =>
    Effect.gen(function* deviceTools() {
      const built = yield* DeviceWorkspaceTools;
      const started = yield* built
        .handle("agent_device_workspace", {
          command: {
            _tag: "start",
            agentSetup: true,
            flowName,
            kind: "teaching",
            operationId: op("device-tool-start"),
            recordingId: null,
            selection,
          },
          platform: "android",
        })
        .pipe(Effect.flatMap(Stream.runCollect));
      expect(started.at(-1)?.isFailure).toBe(false);
      const session = Schema.decodeUnknownSync(AndroidWorkspaceSnapshot)(
        started.at(-1)?.result
      );
      expect(session.phase).toBe("pending");
      expect(session.controller).toBe("agent");
      const read = yield* built
        .handle("agent_device_workspace", {
          command: { _tag: "read", sessionId: session.id },
          platform: "android",
        })
        .pipe(Effect.flatMap(Stream.runCollect));
      const workspace = yield* AndroidWorkspace;
      expect(read.at(-1)?.result).toEqual(
        yield* workspace.execute(
          { _tag: "read", sessionId: session.id },
          "agent"
        )
      );
      const listed = yield* built
        .handle("agent_device_sessions_list", { platform: "android" })
        .pipe(Effect.flatMap(Stream.runCollect));
      expect(listed.at(-1)?.isFailure).toBe(false);
      expect(listed.at(-1)?.result).toEqual(yield* workspace.list());
    }).pipe(Effect.provide(DeviceWorkspaceToolHandlersLive))
  )
);

it.effect(
  "binds one device at a time and refuses a second session until the first closes",
  () =>
    fixture(({ calls }) =>
      Effect.gen(function* oneBoundDevice() {
        const workspace = yield* AndroidWorkspace;
        const start = (id: string, serial: string) =>
          workspace.execute(
            {
              _tag: "start",
              flowName,
              kind: "teaching",
              operationId: op(id),
              recordingId: null,
              selection: {
                ...selection,
                device: { ...selection.device, serial },
              },
            },
            "user"
          );
        const first = yield* start("start-first", "emulator-5554");
        const before = calls.length;
        const other = yield* Effect.flip(start("start-other", "emulator-5556"));
        expect(other.message).toContain(
          "Multiple bound devices are unsupported"
        );
        const same = yield* Effect.flip(start("start-same", "emulator-5554"));
        expect(same.message).toContain(`${first.id} is already bound`);
        expect(calls.length).toBe(before);
        yield* workspace.execute(
          {
            _tag: "close",
            operationId: op("close-first"),
            sessionId: first.id,
          },
          "user"
        );
        const next = yield* start("start-next", "emulator-5554");
        expect(next.phase).toBe("pending");
      })
    )
);

/** A status bar clock beside one Target App element. */
const statusBarScreen = (clockWidth: number): AndroidObservation["nodes"] => [
  {
    bounds: { height: 43, width: clockWidth, x: 84, y: 41 },
    covered: false,
    editable: false,
    hittable: false,
    name: "Other window",
    packageName: "com.android.systemui",
    password: false,
    role: "text",
    target: "@e1",
  },
  {
    bounds: { height: 91, width: 1032, x: 24, y: 120 },
    covered: false,
    editable: false,
    hittable: false,
    name: "Account details",
    packageName: "dev.fixture",
    password: false,
    role: "text",
    target: "@e2",
  },
];

it.effect(
  "sends Back when only another window, such as the status bar, changed",
  () =>
    fixture(({ calls, setNodes }) =>
      Effect.gen(function* backPastStatusBar() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: op("start-back"),
            recordingId: null,
            selection,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare"),
            sessionId: started.id,
          },
          "user"
        );
        setNodes(statusBarScreen(92));
        const seen = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: started.id },
          "user"
        );
        // The clock widens between the user's view and the fresh pre-dispatch capture.
        setNodes(statusBarScreen(120));
        yield* workspace.execute(
          {
            _tag: "input",
            action: { _tag: "back" },
            observationId: seen.observation?.id ?? "",
            operationId: op("back"),
            sessionId: started.id,
          },
          "user"
        );
        expect(calls).toContain("back");
        // A change inside the Target App still refuses Back without input.
        const changed = statusBarScreen(120).map((node) =>
          node.packageName === "dev.fixture"
            ? { ...node, name: "Signed in privately" }
            : node
        );
        const before = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: started.id },
          "user"
        );
        setNodes(changed);
        const backs = calls.filter((call) => call === "back").length;
        const refused = yield* Effect.flip(
          workspace.execute(
            {
              _tag: "input",
              action: { _tag: "back" },
              observationId: before.observation?.id ?? "",
              operationId: op("back-changed"),
              sessionId: started.id,
            },
            "user"
          )
        );
        expect(refused.message).toContain("The screen changed before Back");
        expect(calls.filter((call) => call === "back").length).toBe(backs);
      })
    )
);

it.effect("cancelling a mirror capture leaves Teaching intact", () =>
  fixture(({ holdNextCapture }) =>
    Effect.gen(function* cancelMirror() {
      const workspace = yield* AndroidWorkspace;
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("start-teaching"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        { _tag: "prepare", operationId: op("prepare"), sessionId: started.id },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("record-start"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      const gate = yield* holdNextCapture();
      // Navigation away from the mirror interrupts its in-flight request.
      const mirror = yield* Effect.forkChild(
        workspace.execute(
          { _tag: "observe", image: true, sessionId: started.id },
          "user"
        )
      );
      yield* Deferred.await(gate.entered);
      yield* Fiber.interrupt(mirror);
      yield* Deferred.succeed(gate.release, true);
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("record-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      expect(stopped.phase).toBe("running");
      expect(stopped.captureGaps).toEqual([]);
      expect(stopped.captureState?._tag).toBe("ready");
    })
  )
);

it.effect(
  "a newer mirror frame does not consume a unique semantic selection or repeat its dispatch",
  () =>
    fixture(({ calls }) =>
      Effect.gen(function* mirrorSelection() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: op("mirror-start"),
            recordingId: null,
            selection,
          },
          "user"
        );
        const prepared = yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("mirror-prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const mirror = yield* workspace.execute(
          { _tag: "observe", image: true, sessionId: started.id },
          "user"
        );
        expect(mirror.observation?.id).not.toBe(prepared.observation?.id);
        const action = {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: prepared.observation?.id ?? "",
          operationId: op("mirror-input"),
          sessionId: started.id,
        } as const;
        const result = yield* workspace.execute(action, "user");
        expect(result.phase).toBe("running");
        yield* workspace.execute(action, "user");
        expect(calls.filter((call) => call === "activate")).toHaveLength(1);
      })
    )
);

for (const optional of [false, true]) {
  it.effect(
    `records semantic input with ${optional ? "derived" : "declared"} conditions, verifies and purges evidence`,
    () =>
      fixture(({ restart, root }) =>
        Effect.gen(function* lifecycle() {
          const recordingId = yield* teach(optional);
          const fs = yield* FileSystem.FileSystem;
          const packageFile = yield* fs.readFileString(
            path.join(root, "android-edit", "flow.md")
          );
          expect(packageFile).toContain('"platform":"android"');
          expect(packageFile).not.toContain("emulation:");
          expect(packageFile).not.toContain("hosts:");
          const prepared = yield* dryRun(recordingId);
          const workspace = yield* AndroidWorkspace;
          yield* workspace.execute(
            {
              _tag: "complete",
              assessment: {
                explanation: "Home is visible.",
                observationId: prepared.observation?.id ?? "",
                outcome: "working",
              },
              operationId: op("complete-dry"),
              sessionId: prepared.id,
            },
            "agent"
          );
          expect(
            (yield* workspace.execute(
              { _tag: "read", sessionId: prepared.id },
              "agent"
            )).captureState?._tag
          ).toBe("dry-run-passed");
          const denied = yield* Effect.result(
            workspace.execute(
              {
                _tag: "flow-decision",
                decision: "verify",
                operationId: op("agent-verify"),
                sessionId: prepared.id,
              },
              "agent"
            )
          );
          expect(Result.isFailure(denied)).toBe(true);
          const shot = yield* workspace.keyframes(prepared.id);
          expect(shot?.keyframes.length).toBeGreaterThan(0);
          const verified = yield* workspace.execute(
            {
              _tag: "flow-decision",
              decision: "verify",
              operationId: op("user-verify"),
              sessionId: prepared.id,
            },
            "user"
          );
          expect(verified.cleanup?._tag).toBe("purged");
          expect(verified.observation).toBeNull();
          // Cleanup deletes the Dry Run's screens but not what they were, so
          // its Run Summary can say they were deleted, here and after restart.
          const purgedShots = yield* workspace.keyframes(prepared.id);
          expect(purgedShots?.keyframes).toEqual(shot?.keyframes);
          for (const keyframe of shot?.keyframes ?? []) {
            expect(
              yield* fs.exists(
                path.resolve(shot?.directory ?? "", keyframe.path)
              )
            ).toBe(false);
          }
          const reopenedShots = yield* Effect.scoped(
            Effect.flatMap(restart(), (fresh) => fresh.keyframes(prepared.id))
          );
          expect(reopenedShots?.keyframes.map(({ hash }) => hash)).toEqual(
            shot?.keyframes.map(({ hash }) => hash)
          );
          const reopened = yield* Effect.scoped(
            Effect.flatMap(restart(), (fresh) =>
              fresh.execute({ _tag: "read", sessionId: prepared.id }, "agent")
            )
          );
          expect(reopened.captureState?._tag).toBe("verified");
          expect(reopened.cleanup?._tag).toBe("purged");
          const store = yield* TeachingRecordingStore;
          expect(
            yield* fs.exists(
              path.join(store.directory(recordingId), "events.jsonl")
            )
          ).toBe(false);
          expect(
            yield* fs.exists(path.join(root, "android-edit", "flow.md"))
          ).toBe(true);
          const later = yield* workspace.execute(
            {
              _tag: "start",
              flowName,
              kind: "run",
              operationId: op("later"),
              recordingId: null,
              selection,
            },
            "agent"
          );
          expect(later.kind).toBe("run");
          expect(yield* workspace.activeRunFlowNames()).toContain(flowName);
          yield* workspace.execute(
            {
              _tag: "close",
              operationId: op("close-later-run"),
              sessionId: later.id,
            },
            "user"
          );
          expect(yield* workspace.activeRunFlowNames()).toEqual([]);
        })
      )
  );
}

it.effect(
  "Takeover disables agent dispatch and prevents a passing Dry Run after return",
  () =>
    fixture(() =>
      Effect.gen(function* takeover() {
        const recordingId = yield* teach();
        const prepared = yield* dryRun(recordingId);
        const workspace = yield* AndroidWorkspace;
        const taken = yield* workspace.execute(
          {
            _tag: "control",
            controller: "user",
            operationId: op("takeover"),
            sessionId: prepared.id,
          },
          "user"
        );
        const blocked = yield* Effect.result(
          workspace.execute(
            {
              _tag: "input",
              action: { _tag: "activate", target: "@e2" },
              observationId: taken.observation?.id ?? "",
              operationId: op("blocked-input"),
              sessionId: prepared.id,
            },
            "agent"
          )
        );
        expect(Result.isFailure(blocked)).toBe(true);
        const returned = yield* workspace.execute(
          {
            _tag: "control",
            controller: "agent",
            operationId: op("return"),
            sessionId: prepared.id,
          },
          "user"
        );
        const completed = yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Home remains visible.",
              observationId: returned.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("complete"),
            sessionId: prepared.id,
          },
          "agent"
        );
        expect(completed.captureState?._tag).toBe("dry-run-failed");
        expect(completed.assessment?.outcome).toBe("inconclusive");
      })
    )
);

it.effect(
  "disconnect ends Teaching incomplete and does not replay a failed input",
  () =>
    fixture(({ disconnect, calls }) =>
      Effect.gen(function* incomplete() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: op("start"),
            recordingId: null,
            selection,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const recording = yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("record"),
            sessionId: started.id,
            start: true,
          },
          "user"
        );
        disconnect();
        const command = {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: recording.observation?.id ?? "",
          operationId: op("input"),
          sessionId: started.id,
        } as const;
        expect(
          Result.isFailure(
            yield* Effect.result(workspace.execute(command, "user"))
          )
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(workspace.execute(command, "user"))
          )
        ).toBe(true);
        expect(calls).not.toContain("activate");
        const failed = yield* workspace.execute(
          { _tag: "read", sessionId: started.id },
          "agent"
        );
        expect(failed.phase).toBe("paused");
        expect(failed.captureState?._tag).toBe("failed");
        expect(failed.captureGaps).toContain("device_disconnected");
      })
    )
);

const preparePick = Effect.gen(function* preparePickSession() {
  const workspace = yield* AndroidWorkspace;
  const started = yield* workspace.execute(
    {
      _tag: "start",
      flowName,
      kind: "teaching",
      operationId: op("pick-start"),
      recordingId: null,
      selection,
    },
    "user"
  );
  return yield* workspace.execute(
    { _tag: "prepare", operationId: op("pick-prepare"), sessionId: started.id },
    "user"
  );
});
const pickNode = (
  overrides: Partial<AndroidObservation["nodes"][number]> = {}
): AndroidObservation["nodes"][number] => ({
  bounds: { height: 1, width: 1, x: 0, y: 0 },
  covered: false,
  editable: false,
  hittable: true,
  name: "Edit",
  packageName: "dev.fixture",
  password: false,
  role: "button",
  target: "@picked",
  ...overrides,
});
const tap = (x: number, y: number): [NativeInput, ...NativeInput[]] => [
  { _tag: "touch", action: "down", at: 0, x, y },
  { _tag: "touch", action: "up", at: 50, x, y },
];
const forward = (
  sessionId: AgentSessionId,
  inputs: readonly [NativeInput, ...NativeInput[]]
) =>
  Effect.gen(function* forwardInput() {
    const workspace = yield* AndroidWorkspace;
    // Forwarding answers with nothing; read the session it changed.
    yield* workspace.forward({ inputs, sessionId }, "user");
    return yield* workspace.execute({ _tag: "read", sessionId }, "user");
  });
const teachingEvents = (recordingId: TeachingRecordingId | null) =>
  Effect.gen(function* readTeachingEvents() {
    const store = yield* TeachingRecordingStore;
    const fs = yield* FileSystem.FileSystem;
    if (recordingId === null) {
      return yield* Effect.die("Recording missing.");
    }
    return yield* fs.readFileString(
      path.join(store.directory(recordingId), "events.jsonl")
    );
  });

it.effect(
  "forwards a tap to the device and records it as an attributed action",
  () =>
    fixture(({ calls, forwarded }) =>
      Effect.gen(function* forwardTap() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("forward-record"),
            sessionId: prepared.id,
            start: true,
          },
          "user"
        );
        yield* forward(prepared.id, tap(0.4, 0.6));
        // The input reached the device as it was, with no semantic dispatch.
        expect(forwarded).toEqual([tap(0.4, 0.6)]);
        expect(calls).toEqual([]);
        const stopped = yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("forward-stop"),
            sessionId: prepared.id,
            start: false,
          },
          "user"
        );
        const events = yield* teachingEvents(stopped.recordingId);
        expect(events).toContain("Activate button Edit");
        expect(events).toContain('"targetInferred":false');
        expect(events).not.toMatch(/"(?:point|bounds|frame|x|y)":/u);
      })
    )
);

it.effect("refuses Forwarded Input from anyone but the controlling user", () =>
  fixture(({ forwarded }) =>
    Effect.gen(function* refuseForward() {
      const workspace = yield* AndroidWorkspace;
      const prepared = yield* preparePick;
      const agent = yield* Effect.result(
        workspace.forward(
          { inputs: tap(0.5, 0.5), sessionId: prepared.id },
          "agent"
        )
      );
      expect(Result.isFailure(agent) && agent.failure.message).toBe(
        "Only the user controlling a running session can send input. Nothing was sent."
      );
      expect(forwarded).toEqual([]);
    })
  )
);

it.effect("input never waits behind an observation and makes it stale", () =>
  fixture(({ forwarded, holdNextCapture }) =>
    Effect.scoped(
      Effect.gen(function* inputOvertakesObservation() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        const gate = yield* holdNextCapture();
        const observing = yield* workspace
          .execute(
            { _tag: "observe", image: false, sessionId: prepared.id },
            "user"
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(gate.entered);
        // The observation holds the session lock; input still reaches the
        // device, and forwarding answers without waiting for that lock.
        yield* workspace.forward(
          { inputs: tap(0.5, 0.5), sessionId: prepared.id },
          "user"
        );
        expect(forwarded).toHaveLength(1);
        yield* Deferred.succeed(gate.release, true);
        const observed = yield* Fiber.join(observing);
        expect(observed.observation?.id).toBe(prepared.observation?.id);
      })
    )
  )
);

it.effect(
  "observes quiet input once it settles and records that observation as its result",
  () =>
    fixture(({ holdNextCapture }) =>
      Effect.gen(function* settleForwardedInput() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        const recording = yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("settle-record"),
            sessionId: prepared.id,
            start: true,
          },
          "user"
        );
        const before = recording.observation?.id;
        const gate = yield* holdNextCapture();
        yield* forward(prepared.id, tap(0.5, 0.5));
        // it.effect provides TestClock, so this ends the quiet interval.
        yield* TestClock.adjust(SETTLE_MILLIS * 2);
        yield* Deferred.await(gate.entered);
        yield* Deferred.succeed(gate.release, true);
        // A read queues behind the settling observation on the session lock.
        const settled = yield* workspace.execute(
          { _tag: "read", sessionId: prepared.id },
          "user"
        );
        expect(settled.phase).toBe("running");
        const events = yield* teachingEvents(settled.recordingId);
        const action = events
          .trim()
          .split("\n")
          .map((line) =>
            Schema.decodeUnknownSync(Schema.fromJsonString(TeachingEvent))(line)
          )
          .find((event) => event._tag === "action");
        expect(action?.description).toBe("Activate button Edit");
        expect(action?.after.android?.observationId).not.toBe(before);
      })
    )
);

it.effect(
  "pauses and marks Forwarded Input unverified when its observation fails",
  () =>
    fixture(({ holdNextCapture }) =>
      Effect.gen(function* unverifiedForwardedInput() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        const gate = yield* holdNextCapture();
        yield* forward(prepared.id, tap(0.5, 0.5));
        yield* TestClock.adjust(SETTLE_MILLIS * 2);
        yield* Deferred.await(gate.entered);
        yield* Deferred.succeed(gate.release, false);
        const paused = yield* workspace.execute(
          { _tag: "read", sessionId: prepared.id },
          "user"
        );
        expect(paused.phase).toBe("paused");
        expect(paused.captureGaps).toEqual(
          expect.arrayContaining([
            "device_disconnected",
            "forwarded_input_unverified",
          ])
        );
      })
    )
);

it.effect(
  "marks input that arrives during Stop's final observation unverified",
  () =>
    fixture(({ holdNextCapture }) =>
      Effect.gen(function* stopOvertaken() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("stop-overtaken-start"),
            sessionId: prepared.id,
            start: true,
          },
          "user"
        );
        const gate = yield* holdNextCapture();
        const stopping = yield* workspace
          .execute(
            {
              _tag: "record",
              operationId: op("stop-overtaken-stop"),
              sessionId: prepared.id,
              start: false,
            },
            "user"
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);
        yield* workspace.forward(
          { inputs: tap(0.5, 0.5), sessionId: prepared.id },
          "user"
        );
        yield* Deferred.succeed(gate.release, true);
        const stopped = yield* Fiber.join(stopping);
        expect(stopped.captureGaps).toContain("forwarded_input_unverified");
      })
    )
);

it.effect(
  "validates the environment on a cadence, not on every observation",
  () =>
    fixture(({ disconnect }) =>
      Effect.gen(function* validationCadence() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        disconnect();
        // Within the cadence, an observation of the same app is not checked.
        const unchecked = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: prepared.id },
          "user"
        );
        expect(unchecked.phase).toBe("running");
        yield* TestClock.adjust(OBSERVATION_VALIDATION_MILLIS);
        const checked = yield* Effect.result(
          workspace.execute(
            { _tag: "observe", image: false, sessionId: prepared.id },
            "user"
          )
        );
        expect(Result.isFailure(checked)).toBe(true);
      })
    )
);
it.effect("Dry Run allows untaught activation", () =>
  fixture(({ calls, setNodes }) =>
    Effect.gen(function* taughtGate() {
      const workspace = yield* AndroidWorkspace;
      const recordingId = yield* teach();
      const prepared = yield* dryRun(recordingId);

      const activated = yield* workspace.execute(
        {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: prepared.observation?.id ?? "",
          operationId: op("dry-recorded"),
          sessionId: prepared.id,
        },
        "agent"
      );
      expect(calls.filter((call) => call === "activate")).toHaveLength(2);
      const fs = yield* FileSystem.FileSystem;
      const store = yield* TeachingRecordingStore;
      const actions = yield* fs.readFileString(
        path.join(
          store.directory(recordingId),
          "..",
          "..",
          "runs",
          `agentrun-${prepared.id}`,
          "actions.jsonl"
        )
      );
      expect(actions).not.toMatch(/"(?:point|bounds|frame|x|y)":/u);

      setNodes([pickNode({ name: "Untaught" })]);
      const observed = yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: activated.id },
        "agent"
      );
      const result = yield* Effect.result(
        workspace.execute(
          {
            _tag: "input",
            action: { _tag: "activate", target: "@picked" },
            observationId: observed.observation?.id ?? "",
            operationId: op("dry-untaught"),
            sessionId: prepared.id,
          },
          "agent"
        )
      );
      expect(Result.isSuccess(result)).toBe(true);
      expect(calls.filter((call) => call === "activate")).toHaveLength(3);
    })
  )
);
it.effect(
  "a tapped password field offers its Variables until another tap",
  () =>
    fixture(({ calls, setNodes }) =>
      Effect.gen(function* tappedField() {
        const workspace = yield* AndroidWorkspace;
        const prepared = yield* preparePick;
        setNodes([
          pickNode({
            bounds: { height: 0.5, width: 1, x: 0, y: 0 },
            editable: true,
            name: "Password",
            password: true,
            role: "textbox",
          }),
          pickNode({
            bounds: { height: 0.5, width: 1, x: 0, y: 0.5 },
            name: "Done",
            target: "@done",
          }),
        ]);
        const observed = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: prepared.id },
          "user"
        );
        const tapped = yield* forward(prepared.id, tap(0.5, 0.25));
        expect(calls).toEqual([]);
        expect(tapped.field).toEqual({
          name: "Password",
          observationId: observed.observation?.id,
          password: true,
          role: "textbox",
          target: "@picked",
        });
        // The keyboard opens. Settling the tap keeps the observation the
        // Variable entry is bound to, so the private path stays current.
        setNodes([
          pickNode({
            bounds: { height: 0.25, width: 1, x: 0, y: 0 },
            editable: true,
            name: "Password",
            password: true,
            role: "textbox",
          }),
          pickNode({ name: "Keyboard", target: "@keyboard" }),
        ]);
        yield* TestClock.adjust(SETTLE_MILLIS * 2);
        const settled = yield* workspace.execute(
          { _tag: "read", sessionId: prepared.id },
          "user"
        );
        expect(settled.observation?.id).toBe(observed.observation?.id);
        expect(settled.field?.password).toBe(true);
        // Tapping where no field is leaves every field.
        const elsewhere = yield* forward(prepared.id, tap(0.5, 0.75));
        expect(elsewhere.field).toBeNull();
        const closed = yield* workspace.execute(
          {
            _tag: "close",
            operationId: op("close-tapped-field"),
            sessionId: prepared.id,
          },
          "user"
        );
        expect(closed.field).toBeNull();
      })
    )
);

it("validates Forwarded Input and keeps it out of the MCP tool", () => {
  const sessionId = AgentSessionId.make("agent-android-schema");
  const forwarded = {
    inputs: [
      { _tag: "touch", action: "down", at: 0, x: 0, y: 1 },
      {
        _tag: "scroll",
        at: 1,
        deltaX: 0,
        deltaY: -120,
        x: 0.5,
        y: 0.5,
      },
      {
        _tag: "key",
        action: "down",
        at: 2,
        code: "KeyA",
        key: "a",
        modifiers: 0,
      },
    ],
    sessionId,
  } as const;
  const observationId = "observed";
  const operationId = op("validate-forward");
  expect(Schema.is(NativeForward)(forwarded)).toBe(true);
  for (const input of [
    { _tag: "touch", action: "down", at: 0, x: -0.1, y: 0 },
    { _tag: "touch", action: "down", at: 0, x: 0, y: 1.1 },
    { _tag: "touch", action: "down", at: 0, x: Number.NaN, y: 0 },
    { _tag: "touch", action: "tap", at: 0, x: 0, y: 0 },
    { _tag: "scroll", at: 0, deltaX: 0, deltaY: Infinity, x: 0, y: 0 },
    { _tag: "key", action: "down", at: 0, code: "", key: "", modifiers: 0 },
    { _tag: "key", action: "down", at: 0, code: "", key: "a", modifiers: 16 },
  ]) {
    expect(Schema.is(NativeForward)({ ...forwarded, inputs: [input] })).toBe(
      false
    );
  }
  expect(Schema.is(NativeForward)({ ...forwarded, inputs: [] })).toBe(false);
  // Forwarded Input is not a Workspace command, so MCP cannot send it.
  const command = { ...forwarded, _tag: "forward" } as const;
  expect(Schema.is(AndroidWorkspaceCommand)(command)).toBe(false);
  const parameters =
    DeviceWorkspaceTools.tools.agent_device_workspace.parametersSchema;
  expect(Schema.is(parameters)({ command, platform: "android" })).toBe(false);
  expect(
    Schema.is(parameters)({
      command: {
        _tag: "variable-supply",
        name: "PASSWORD",
        operationId,
        requestId: "request",
        sessionId,
        value: "private",
      },
      platform: "android",
    })
  ).toBe(false);
  expect(
    Schema.is(parameters)({
      command: {
        _tag: "input",
        action: { _tag: "activate", target: "@button" },
        observationId,
        operationId,
        sessionId,
      },
      platform: "android",
    })
  ).toBe(true);
  expect(
    Schema.is(parameters)({
      command: {
        _tag: "start",
        flowName,
        kind: "teaching",
        operationId,
        recordingId: null,
        selection,
      },
      platform: "android",
    })
  ).toBe(true);
});

const required = <A>(value: A | null | undefined): A => {
  if (value === undefined || value === null) {
    throw new Error("Expected fixture value");
  }
  return value;
};
const privateNodes: AndroidObservation["nodes"] = [
  {
    bounds: { height: 1, width: 1, x: 0, y: 0 },
    covered: false,
    editable: false,
    hittable: false,
    name: "Home",
    packageName: "dev.fixture",
    password: false,
    role: "text",
    target: "@home",
  },
  {
    bounds: { height: 1, width: 1, x: 0, y: 0 },
    covered: false,
    editable: true,
    hittable: true,
    name: "Private field",
    packageName: "dev.fixture",
    password: true,
    role: "textbox",
    target: "@password",
  },
];
const privateSelection = { ...selection, privateInput: true };
const privateFlow = `---\nname: android-edit\ndescription: Log in with a private password. Use when testing private login.\ninputs:\n  - password\n---\n\n# Log in\n\n1. Enter {{password}} in the password field. Done when: Home is visible.\n`;
const requestPrivate = (
  workspace: AndroidWorkspaceService,
  sessionId: AgentSessionId,
  name: string,
  source: "agent" | "user",
  suffix: string,
  replace = false
) =>
  workspace.execute(
    {
      _tag: "variable-request",
      name,
      operationId: op(`request-${suffix}`),
      purpose: "Log in privately",
      replace,
      sessionId,
    },
    source
  );
const supplyPrivate = (
  workspace: AndroidWorkspaceService,
  sessionId: AgentSessionId,
  variable: { readonly name: string; readonly requestId: string },
  value: string | null,
  suffix: string
) =>
  workspace.execute(
    {
      _tag: "variable-supply",
      ...variable,
      operationId: op(`supply-${suffix}`),
      sessionId,
      value,
    },
    "user"
  );
const enterPrivate = (
  workspace: AndroidWorkspaceService,
  sessionId: AgentSessionId,
  name: string,
  source: "agent" | "user",
  suffix: string
) =>
  Effect.gen(function* enter() {
    const observed = yield* workspace.execute(
      { _tag: "observe", image: false, sessionId },
      source
    );
    return yield* workspace.execute(
      {
        _tag: "input",
        action: { _tag: "variable", name, target: "@password" },
        observationId: observed.observation?.id ?? "",
        operationId: op(`enter-${suffix}`),
        sessionId,
      },
      source
    );
  });

it.effect(
  "teaches private references, learns, verifies a fresh Dry Run, and requires fresh supply in later Runs",
  () =>
    fixture(({ calls, resolved, root, setNodes }) =>
      Effect.gen(function* privateJourney() {
        setNodes(privateNodes);
        const workspace = yield* AndroidWorkspace;
        const store = yield* TeachingRecordingStore;
        const learning = yield* TeachingRecordingLearning;
        const fs = yield* FileSystem.FileSystem;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: op("private-start"),
            recordingId: null,
            selection: privateSelection,
          },
          "user"
        );
        const sessionId = started.id;
        yield* workspace.execute(
          { _tag: "prepare", operationId: op("private-prepare"), sessionId },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("private-record"),
            sessionId,
            start: true,
          },
          "user"
        );
        const requested = yield* requestPrivate(
          workspace,
          sessionId,
          "PASSWORD",
          "user",
          "teaching"
        );
        const variable = requested.variables?.[0];
        if (!variable || !started.recordingId) {
          return yield* Effect.die("Private recording missing");
        }
        const sentinel = "private-workspace-sentinel";
        const supplied = yield* supplyPrivate(
          workspace,
          sessionId,
          variable,
          sentinel,
          "teaching"
        );
        expect(JSON.stringify(supplied)).not.toContain(sentinel);
        const observed = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId },
          "user"
        );
        expect(observed.observation).not.toBeNull();
        const picked = yield* forward(sessionId, tap(0.5, 0.5));
        const mirrored = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId },
          "user"
        );
        expect(mirrored.observation?.id).toBe(picked.observation?.id);
        expect(mirrored.field).toEqual(picked.field);
        const privateCommand = {
          _tag: "input",
          action: { _tag: "variable", name: "PASSWORD", target: "@password" },
          observationId: required(picked.field).observationId,
          operationId: op("enter-teaching"),
          sessionId,
        } as const;
        yield* workspace.execute(privateCommand, "user");
        expect(calls).toEqual(["private"]);
        expect(required(resolved[0])).toBe(sentinel);
        yield* workspace.execute(privateCommand, "user");
        expect(calls).toEqual(["private"]);
        const stale = yield* workspace
          .execute(
            { ...privateCommand, operationId: op("stale-private-repeat") },
            "user"
          )
          .pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
        yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("private-stop"),
            sessionId,
            start: false,
          },
          "user"
        );
        yield* workspace.execute(
          { _tag: "close", operationId: op("private-close"), sessionId },
          "user"
        );
        expect(resolved).toHaveLength(1);
        const { recordingId } = started;
        yield* store.startLearning({
          operationId: op("private-claim"),
          recordingId,
        });
        const timeline = yield* learning.timeline({
          claimOperationId: op("private-claim"),
          cursor: 0,
          recordingId,
        });
        expect(JSON.stringify(timeline)).toContain('"variableName":"PASSWORD"');
        expect(JSON.stringify(timeline)).toContain(sentinel);
        expect(
          timeline.entries.find(
            (entry) => entry._tag === "action" && entry.kind === "variable"
          )
        ).toMatchObject({
          inputConfirmation: "unconfirmed",
          outcome: "succeeded",
        });
        const events = yield* fs.readFileString(
          path.join(store.directory(recordingId), "events.jsonl")
        );
        expect(events).toContain(sentinel);
        expect(events).toContain('"valueWithheld":null');
        const saved = yield* learning.save({
          claimOperationId: op("private-claim"),
          files: [{ content: privateFlow, path: "flow.md" }],
          operationId: op("private-save"),
          recordingId,
        });
        expect(JSON.stringify(saved)).not.toContain(sentinel);
        for (const kind of ["dry-run", "run"] as const) {
          const run = yield* workspace.execute(
            {
              _tag: "start",
              flowName,
              kind,
              operationId: op(`private-${kind}`),
              recordingId: kind === "dry-run" ? recordingId : null,
              selection: privateSelection,
            },
            "agent"
          );
          expect(run.variables?.[0]?.status).toBe("requested");
          yield* workspace.execute(
            {
              _tag: "prepare",
              operationId: op(`prepare-${kind}`),
              sessionId: run.id,
            },
            "user"
          );
          const missing = yield* enterPrivate(
            workspace,
            run.id,
            "PASSWORD",
            "agent",
            `missing-${kind}`
          ).pipe(Effect.result);
          expect(missing._tag).toBe("Failure");
          yield* supplyPrivate(
            workspace,
            run.id,
            required(required(run.variables)[0]),
            sentinel,
            kind
          );
          const filled = yield* enterPrivate(
            workspace,
            run.id,
            "PASSWORD",
            "agent",
            kind
          );
          const finished = yield* workspace.execute(
            {
              _tag: "complete",
              assessment: {
                explanation: "Home is visible after private login",
                observationId: required(filled.observation).id,
                outcome: "working",
              },
              operationId: op(`complete-${kind}`),
              sessionId: run.id,
            },
            "agent"
          );
          expect(finished.assessment?.outcome).toBe("working");
          expect(finished.variables).toEqual([]);
          if (kind === "dry-run") {
            yield* workspace.execute(
              {
                _tag: "flow-decision",
                decision: "verify",
                operationId: op("verify-private"),
                sessionId: run.id,
              },
              "user"
            );
            expect(yield* fs.exists(store.directory(recordingId))).toBe(false);
          }
          const summary = yield* fs.readFileString(
            path.join(root, ".android-workspace", `${run.id}.json`)
          );
          expect(summary).not.toContain(sentinel);
          // The keyframes outlive the process beside the summary, and carry
          // no private value.
          const index = yield* fs.readFileString(
            path.join(root, ".android-workspace", `${run.id}.keyframes.json`)
          );
          expect(index).not.toContain(sentinel);
          const kept = JSON.parse(index);
          expect(kept.keyframes.length).toBeGreaterThan(0);
          expect(yield* workspace.keyframes(run.id)).toMatchObject({
            directory: kept.directory,
          });
        }
        expect(calls).toEqual(["private", "private", "private"]);
      })
    )
);

it.effect(
  "Setup Variables replace, refuse stale supplies, replay once, and expire at handoff without entering Teaching",
  () =>
    fixture(({ calls, resolved, setNodes }) =>
      Effect.gen(function* setupVariables() {
        setNodes(privateNodes);
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            agentSetup: true,
            flowName,
            kind: "teaching",
            operationId: op("setup-start"),
            recordingId: null,
            selection: privateSelection,
          },
          "agent"
        );
        const sessionId = started.id;
        yield* workspace.execute(
          { _tag: "prepare", operationId: op("setup-prepare"), sessionId },
          "user"
        );
        const requested = yield* requestPrivate(
          workspace,
          sessionId,
          "SETUP_PASSWORD",
          "agent",
          "setup"
        );
        const original = required(required(requested.variables)[0]);
        yield* supplyPrivate(
          workspace,
          sessionId,
          original,
          "first-setup-sentinel",
          "first"
        );
        yield* enterPrivate(
          workspace,
          sessionId,
          "SETUP_PASSWORD",
          "agent",
          "setup"
        );
        const replacement = yield* requestPrivate(
          workspace,
          sessionId,
          "SETUP_PASSWORD",
          "agent",
          "replacement",
          true
        );
        expect(resolved).toHaveLength(1);
        expect(
          (yield* supplyPrivate(
            workspace,
            sessionId,
            original,
            "stale",
            "stale"
          ).pipe(Effect.result))._tag
        ).toBe("Failure");
        yield* supplyPrivate(
          workspace,
          sessionId,
          required(required(replacement.variables)[0]),
          null,
          "refuse"
        );
        expect(
          (yield* enterPrivate(
            workspace,
            sessionId,
            "SETUP_PASSWORD",
            "agent",
            "refused"
          ).pipe(Effect.result))._tag
        ).toBe("Failure");
        const next = yield* requestPrivate(
          workspace,
          sessionId,
          "SETUP_PASSWORD",
          "agent",
          "again",
          true
        );
        yield* supplyPrivate(
          workspace,
          sessionId,
          required(required(next.variables)[0]),
          "second-setup-sentinel",
          "second"
        );
        const handed = yield* workspace.execute(
          { _tag: "setup-handoff", operationId: op("handoff"), sessionId },
          "agent"
        );
        expect(handed.variables).toEqual([]);
        expect(handed.controller).toBe("user");
        expect(
          (yield* enterPrivate(
            workspace,
            sessionId,
            "SETUP_PASSWORD",
            "agent",
            "expired"
          ).pipe(Effect.result))._tag
        ).toBe("Failure");
        expect(calls).toEqual(["private"]);
        const store = yield* TeachingRecordingStore;
        const fs = yield* FileSystem.FileSystem;
        expect(
          yield* fs.exists(
            path.join(
              store.directory(required(started.recordingId)),
              "events.jsonl"
            )
          )
        ).toBe(false);
      })
    )
);

it.effect(
  "private input refuses wrong, stale, and moved fields without resolving a value",
  () =>
    fixture(({ calls, setNodes }) =>
      Effect.gen(function* privateRefusals() {
        setNodes(privateNodes);
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            agentSetup: true,
            flowName,
            kind: "teaching",
            operationId: op("refusal-start"),
            recordingId: null,
            selection: privateSelection,
          },
          "agent"
        );
        const sessionId = started.id;
        yield* workspace.execute(
          { _tag: "prepare", operationId: op("refusal-prepare"), sessionId },
          "user"
        );
        const request = yield* requestPrivate(
          workspace,
          sessionId,
          "PASSWORD",
          "agent",
          "refusal"
        );
        yield* supplyPrivate(
          workspace,
          sessionId,
          required(required(request.variables)[0]),
          "refusal-sentinel",
          "refusal"
        );
        const observed = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId },
          "agent"
        );
        for (const [target, observationId] of [
          ["@home", required(observed.observation).id],
          ["@password", "stale-observation"],
        ]) {
          const refused = yield* workspace
            .execute(
              {
                _tag: "input",
                action: {
                  _tag: "variable",
                  name: "PASSWORD",
                  target: required(target),
                },
                observationId: required(observationId),
                operationId: op(`refuse-${target}-${observationId}`),
                sessionId,
              },
              "agent"
            )
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
        }
        const newer = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId },
          "agent"
        );
        expect(
          (yield* workspace
            .execute(
              {
                _tag: "input",
                action: {
                  _tag: "variable",
                  name: "PASSWORD",
                  target: "@password",
                },
                observationId: required(observed.observation).id,
                operationId: op("superseded-private"),
                sessionId,
              },
              "agent"
            )
            .pipe(Effect.result))._tag
        ).toBe("Failure");
        setNodes(
          privateNodes.map((node) =>
            node.password
              ? { ...node, bounds: { height: 1, width: 1, x: 1, y: 1 } }
              : node
          )
        );
        expect(
          (yield* workspace
            .execute(
              {
                _tag: "input",
                action: {
                  _tag: "variable",
                  name: "PASSWORD",
                  target: "@password",
                },
                observationId: required(newer.observation).id,
                operationId: op("moved-private"),
                sessionId,
              },
              "agent"
            )
            .pipe(Effect.result))._tag
        ).toBe("Failure");
        expect(calls).toEqual([]);
      })
    )
);

it.effect(
  "a secure window pauses a Run and forces its assessment to inconclusive",
  () =>
    fixture(({ secure }) =>
      Effect.gen(function* secureWindow() {
        const recordingId = yield* teach();
        const session = yield* dryRun(recordingId);
        const workspace = yield* AndroidWorkspace;
        secure();
        // The environment is checked on its cadence, not on every observation.
        yield* TestClock.adjust(OBSERVATION_VALIDATION_MILLIS);
        const refused = yield* workspace
          .execute(
            { _tag: "observe", image: false, sessionId: session.id },
            "agent"
          )
          .pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        const paused = yield* workspace.execute(
          { _tag: "read", sessionId: session.id },
          "agent"
        );
        expect(paused.phase).toBe("paused");
        expect(paused.error).toContain("Secure window, not visible");
        const finished = yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Secure window hides the outcome",
              observationId: required(session.observation).id,
              outcome: "working",
            },
            operationId: op("secure-complete"),
            sessionId: session.id,
          },
          "agent"
        );
        expect(finished.assessment?.outcome).toBe("inconclusive");
        expect(finished.captureState?._tag).toBe("dry-run-failed");
      })
    )
);

it.effect("Confirmation permits user input during Takeover", () =>
  fixture(({ calls }) =>
    Effect.gen(function* takeoverConfirmation() {
      const workspace = yield* AndroidWorkspace;
      const prepared = yield* dryRun(yield* teach());
      const pending = yield* workspace.execute(
        {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          irreversible: true,
          observationId: prepared.observation?.id ?? "",
          operationId: op("pending"),
          sessionId: prepared.id,
        },
        "agent"
      );
      const controlled = yield* workspace.execute(
        {
          _tag: "control",
          controller: "user",
          operationId: op("take"),
          sessionId: prepared.id,
        },
        "user"
      );
      expect(controlled.phase).toBe("running");
      expect(controlled.boundary).toEqual(pending.boundary);
      const initial = calls.filter((call) => call === "activate").length;
      yield* workspace.execute(
        {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: controlled.observation?.id ?? "",
          operationId: op("user-input"),
          sessionId: prepared.id,
        },
        "user"
      );
      expect(calls.filter((call) => call === "activate")).toHaveLength(
        initial + 1
      );
      const returned = yield* workspace.execute(
        {
          _tag: "control",
          controller: "agent",
          operationId: op("return"),
          sessionId: prepared.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: returned.observation?.id ?? "",
          operationId: op("blocked-agent"),
          sessionId: prepared.id,
        },
        "agent"
      );
      expect(calls.filter((call) => call === "activate")).toHaveLength(
        initial + 1
      );
    })
  )
);

for (const source of ["agent", "user"] as const) {
  for (const allow of [true, false]) {
    it.effect(
      `Android Confirmation via ${source} ${allow ? "allows once" : "refuses"}`,
      () =>
        fixture(({ calls }) =>
          Effect.gen(function* confirmation() {
            const workspace = yield* AndroidWorkspace;
            const prepared = yield* dryRun(yield* teach());
            const initial = calls.filter((call) => call === "activate").length;
            const paused = yield* workspace.execute(
              {
                _tag: "input",
                action: { _tag: "activate", target: "@e2" },
                irreversible: true,
                observationId: prepared.observation?.id ?? "",
                operationId: op("confirm-attempt"),
                sessionId: prepared.id,
              },
              "agent"
            );
            expect(paused.pendingDecision?.kind).toBe("boundary");
            expect(paused.boundary?.reason).toBe("confirmation");
            expect(paused.phase).toBe("running");
            expect(paused.boundary?.description).toBe(
              'Activate button "Edit" in dev.fixture'
            );
            expect(calls.filter((call) => call === "activate")).toHaveLength(
              initial
            );
            for (let frame = 0; frame < 12; frame += 1) {
              yield* workspace.execute(
                { _tag: "observe", image: false, sessionId: prepared.id },
                "agent"
              );
            }
            const resolved = yield* workspace.execute(
              {
                _tag: "decide",
                allow,
                decisionId: paused.pendingDecision?.pendingDecisionId ?? "",
                operationId: op("confirm-decision"),
                sessionId: prepared.id,
              },
              source
            );
            expect(calls.filter((call) => call === "activate")).toHaveLength(
              initial + (allow ? 1 : 0)
            );
            expect(resolved.pendingDecision).toBeNull();
            const retry = yield* workspace.execute(
              {
                _tag: "input",
                action: { _tag: "activate", target: "@e2" },
                irreversible: true,
                observationId: resolved.observation?.id ?? "",
                operationId: op("confirm-retry"),
                sessionId: prepared.id,
              },
              "agent"
            );
            expect(retry.pendingDecision?.pendingDecisionId).not.toBe(
              paused.pendingDecision?.pendingDecisionId
            );
            expect(calls.filter((call) => call === "activate")).toHaveLength(
              initial + (allow ? 1 : 0)
            );
          })
        )
    );
  }
}

it.effect("Workspace Teaching can tap another app", () =>
  fixture(({ calls, forwarded, setNodes }) =>
    Effect.gen(function* systemPick() {
      const workspace = yield* AndroidWorkspace;
      const prepared = yield* preparePick;
      setNodes([
        pickNode({
          name: "Allow",
          packageName: "com.android.permissioncontroller",
        }),
      ]);
      const observed = yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: prepared.id },
        "user"
      );
      expect(observed.observation).not.toBeNull();
      yield* forward(prepared.id, tap(0.5, 0.5));
      // Forwarded Input reaches any app on the device.
      expect(forwarded).toEqual([tap(0.5, 0.5)]);
      expect(calls).toEqual([]);
    })
  )
);

for (const existing of [false, true]) {
  it.effect(
    `starts native Teaching in the ${existing ? "existing" : "selected"} Group without a root draft`,
    () =>
      fixture(({ root }) =>
        Effect.gen(function* groupedTeaching() {
          const fs = yield* FileSystem.FileSystem;
          const owner = path.join(root, "shop", "checkout");
          if (existing) {
            yield* fs.makeDirectory(owner, { recursive: true });
            yield* fs.writeFileString(
              path.join(owner, "flow.md"),
              flow.replaceAll("android-edit", "checkout")
            );
          }
          const workspace = yield* AndroidWorkspace;
          const command: Mutable<
            Extract<AndroidWorkspaceCommand, { _tag: "start" }>
          > = {
            _tag: "start",
            flowName: FlowName.make("checkout"),
            kind: "teaching",
            operationId: op("grouped-start"),
            recordingId: null,
            selection,
          };
          if (!existing) {
            command.group = "shop";
          }
          const started = yield* workspace.execute(command, "user");
          expect(started.recordingId).not.toBeNull();
          const store = yield* TeachingRecordingStore;
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching must own a recording");
          }
          expect(store.directory(started.recordingId)).toBe(
            path.join(owner, "recordings", started.recordingId)
          );
          expect(yield* fs.exists(path.join(root, "checkout"))).toBe(false);
          expect((yield* store.read(started.recordingId)).flowName).toBe(
            "checkout"
          );
          yield* workspace.execute(
            {
              _tag: "close",
              operationId: op("grouped-close"),
              sessionId: started.id,
            },
            "user"
          );
        })
      )
  );
}

it.effect(
  "blocks preparation when a derived starting condition is absent",
  () =>
    fixture(({ setNodes }) =>
      Effect.gen(function* missingStart() {
        const recordingId = yield* teach(true);
        setNodes([]);
        const refused = yield* Effect.flip(dryRun(recordingId));
        expect(refused.code).toBe("starting_condition_failed");
      })
    )
);

it.effect(
  "refuses a passing assessment when a derived outcome disappears",
  () =>
    fixture(({ setNodes }) =>
      Effect.gen(function* missingOutcome() {
        const prepared = yield* dryRun(yield* teach(true));
        setNodes([]);
        const workspace = yield* AndroidWorkspace;
        const completed = yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Claim success without the required outcome.",
              observationId: prepared.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("missing-outcome"),
            sessionId: prepared.id,
          },
          "agent"
        );
        expect(completed.assessment?.outcome).toBe("inconclusive");
        expect(completed.captureState?._tag).toBe("dry-run-failed");
      })
    )
);

it.effect(
  "confirmed setup prepares once and retries failed capture within the retained session",
  () =>
    fixture(({ disconnect, reconnect, calls }) =>
      Effect.gen(function* confirmedSetup() {
        const workspace = yield* AndroidWorkspace;
        const command = {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("confirmed-setup"),
          prepareAndOpen: true,
          recordingId: null,
          selection,
        } as const;
        expect(
          (yield* Effect.flip(workspace.execute(command, "agent"))).code
        ).toBe("android_workspace_refused");
        disconnect();
        const failed = yield* workspace.execute(command, "user");
        expect(failed.phase).toBe("paused");
        expect(failed.preparation.phase).toBe("paused");
        const originalError = failed.error;
        expect(originalError).not.toBeNull();
        const repeated = yield* workspace.execute(command, "user");
        expect(repeated.id).toBe(failed.id);
        expect(repeated.error).toBe(originalError);
        yield* Effect.flip(
          workspace.execute(
            {
              _tag: "recover",
              operationId: op("unusable-recovery"),
              sessionId: failed.id,
            },
            "user"
          )
        );
        const retained = yield* workspace.execute(
          { _tag: "read", sessionId: failed.id },
          "user"
        );
        expect(retained.error).toBe(originalError);
        reconnect();
        const ready = yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("retry-preparation"),
            sessionId: failed.id,
          },
          "user"
        );
        expect(ready.id).toBe(failed.id);
        expect(ready.phase).toBe("running");
        expect(ready.error).toBeNull();
        expect(ready.observation).not.toBeNull();
        expect(calls).not.toContain("activate");
        const repeatedReady = yield* workspace.execute(command, "user");
        expect(repeatedReady.id).toBe(ready.id);
        expect(repeatedReady.phase).toBe("running");
      })
    )
);

it.effect("coalesces concurrent confirmation of the same setup operation", () =>
  fixture(({ holdNextCapture }) =>
    Effect.gen(function* concurrentConfirmation() {
      const workspace = yield* AndroidWorkspace;
      const gate = yield* holdNextCapture();
      const command = {
        _tag: "start",
        flowName,
        kind: "teaching",
        operationId: op("concurrent-confirmation"),
        prepareAndOpen: true,
        recordingId: null,
        selection,
      } as const;
      const first = yield* Effect.forkChild(workspace.execute(command, "user"));
      yield* Deferred.await(gate.entered);
      const duplicate = yield* Effect.forkChild(
        workspace.execute(command, "user")
      );
      yield* Deferred.succeed(gate.release, true);
      const prepared = yield* Fiber.join(first);
      const replay = yield* Fiber.join(duplicate);
      expect(prepared.phase).toBe("running");
      expect(replay.id).toBe(prepared.id);
      expect(
        replay.preparation.evidence.filter((event) => event.type === "setup")
      ).toHaveLength(1);
      expect(
        (yield* workspace.list()).filter((entry) => entry.phase === "running")
      ).toHaveLength(1);
      const stale = yield* Effect.flip(
        workspace.execute(
          {
            ...command,
            selection: { ...selection, apkPath: "/different.apk" },
          },
          "user"
        )
      );
      expect(stale.code).toBe("android_workspace_refused");
    })
  )
);

it.effect(
  "retains interrupted confirmed preparation for explicit same-session retry",
  () =>
    fixture(({ holdNextCapture }) =>
      Effect.gen(function* interruptedPreparation() {
        const workspace = yield* AndroidWorkspace;
        const gate = yield* holdNextCapture();
        const command = {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("interrupted-confirmation"),
          prepareAndOpen: true,
          recordingId: null,
          selection,
        } as const;
        const fiber = yield* Effect.forkChild(
          workspace.execute(command, "user")
        );
        yield* Deferred.await(gate.entered);
        yield* Fiber.interrupt(fiber);
        const retained = yield* workspace.execute(command, "user");
        expect(retained.phase).toBe("paused");
        expect(retained.error).toContain("canceled");
        const ready = yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("explicit-retry"),
            sessionId: retained.id,
          },
          "user"
        );
        expect(ready.id).toBe(retained.id);
        expect(ready.phase).toBe("running");
      })
    )
);
