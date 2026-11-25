import path from "node:path";

import {
  IosWorkspaceCommand,
  FlowName,
  OperationId,
  IosObservationRefusal,
} from "@contingency/protocol";
import type { IosWorkspaceSelection } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema, Stream } from "effect";
import type { Mutable } from "effect/Types";

import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import {
  iosCapabilities,
  iosRuntimeError,
  iosSystemKeys,
} from "../../src/services/ios-runtime.ts";
import type { IosObservation } from "../../src/services/ios-runtime.ts";
import type { IosDeviceStream } from "../../src/services/ios-stream.ts";
import {
  IosWorkspace,
  iosWorkspaceRefusal,
  makeIosWorkspaceLayer,
} from "../../src/services/ios-workspace.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import {
  TargetAppBuilds,
  targetAppBuildError,
} from "../../src/services/target-app-builds.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";

const selection: IosWorkspaceSelection = {
  device: {
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    kind: "simulator",
    name: "iPhone 17",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    runtimeVersion: "26.5",
    udid: "11111111-2222-3333-4444-555555555555",
  },
  environment: {
    build: "1",
    bundleId: "dev.contingency.ioslogin",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    runtimeVersion: "26.5",
  },
  outcomes: [{ name: "Signed in", role: "text" }],
  setup: {
    conditions: [{ name: "Login fixture", role: "text" }],
    kind: "restart-app",
  },
};

it.effect(
  "refuses a physical iPhone selection at the Workspace entry point before discovery",
  () =>
    Effect.gen(function* physicalSelection() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "ios-workspace-test-",
      });
      // Agents reach Workspace through decoded commands; a physical iPhone must decode.
      const command = Schema.decodeUnknownSync(IosWorkspaceCommand)({
        _tag: "start",
        flowName: "ios-login",
        kind: "teaching",
        operationId: "physical-1",
        recordingId: null,
        selection: {
          ...selection,
          device: {
            kind: "physical",
            name: "iPhone",
            udid: "00008030-001A2C3E0A88802E",
          },
        },
      });
      const store = makeTeachingRecordingStoreLayer({ root: () => root });
      const workspace = yield* Layer.build(
        makeIosWorkspaceLayer({ root: () => root }).pipe(
          Layer.provide(Layer.merge(store, makeFlowCatalogLayer({ root })))
        )
      );
      const service = yield* IosWorkspace.pipe(Effect.provide(workspace));
      const refused = yield* Effect.result(service.execute(command, "agent"));
      expect(Result.isFailure(refused) && refused.failure.code).toBe(
        "physical_device_unsupported"
      );
      expect(yield* service.list()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it("exposes a typed, recoverable refusal when the display becomes unavailable", () => {
  expect(iosWorkspaceRefusal("capture_incomplete")).toEqual({
    code: "capture_incomplete",
    recovery: "recover",
  });
  expect(iosWorkspaceRefusal("foreground_app_unknown")).toEqual({
    code: "foreground_app_unknown",
    recovery: "go-home",
  });
  // The observer follows any app in front, so another app is no refusal.
  expect(iosWorkspaceRefusal("foreign_app_foreground")).toBe(null);
  expect(iosWorkspaceRefusal("runtime_failed")).toBe(null);
});

it("keeps each iOS refusal bound to its recovery command", () => {
  const decode = Schema.decodeUnknownResult(IosObservationRefusal);
  expect(decode(iosWorkspaceRefusal("capture_incomplete"))._tag).toBe(
    "Success"
  );
  expect(decode({ code: "capture_incomplete", recovery: "go-home" })._tag).toBe(
    "Failure"
  );
  expect(
    decode({ code: "foreground_app_unknown", recovery: "recover" })._tag
  ).toBe("Failure");
});

for (const existing of [false, true]) {
  it.effect(
    `starts iOS Teaching in the ${existing ? "existing" : "selected"} Group without a root draft`,
    () =>
      Effect.gen(function* groupedTeaching() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const owner = path.join(root, "shop", "checkout");
        if (existing) {
          yield* fs.makeDirectory(owner, { recursive: true });
          yield* fs.writeFileString(
            path.join(owner, "flow.md"),
            "---\nname: checkout\ndescription: Check out.\n---\n1. Open the shop. Done when: the shop appears.\n"
          );
        }
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const workspaceLayer = makeIosWorkspaceLayer({
          root: () => root,
          runDeps: {
            installedBuild: () => Effect.succeed(null),
            preflight: () => Effect.void,
            restart: () => Effect.void,
            start: () => Effect.die("Startup must not prepare the simulator"),
          },
        }).pipe(
          Layer.provide(Layer.merge(storeLayer, makeFlowCatalogLayer({ root })))
        );
        yield* Effect.gen(function* startInGroup() {
          const workspace = yield* IosWorkspace;
          const store = yield* TeachingRecordingStore;
          const command: Mutable<
            Extract<IosWorkspaceCommand, { _tag: "start" }>
          > = {
            _tag: "start",
            flowName: FlowName.make("checkout"),
            kind: "teaching",
            operationId: OperationId.make("grouped-start"),
            recordingId: null,
            selection: {
              ...selection,
              outcomes: [],
              setup: { conditions: [], kind: "restart-app" },
            },
          };
          if (!existing) {
            command.group = "shop";
          }
          const started = yield* workspace.execute(command, "user");
          expect(yield* workspace.activeRunFlowNames()).toEqual([]);
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
              operationId: OperationId.make("grouped-close"),
              sessionId: started.id,
            },
            "user"
          );
          // A closed session's scope is gone; observing it is refused in words.
          expect(
            yield* Effect.flip(
              workspace.execute(
                { _tag: "observe", image: false, sessionId: started.id },
                "agent"
              )
            )
          ).toMatchObject({
            code: "ios_workspace_refused",
            message: expect.stringContaining("has ended"),
          });
        }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}

it.effect(
  "lists only the iOS sessions this process owns and the user can continue",
  () =>
    Effect.gen(function* liveIosSessions() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const workspaceLayer = makeIosWorkspaceLayer({
        root: () => root,
        runDeps: {
          installedBuild: () => Effect.succeed(null),
          preflight: () => Effect.void,
          restart: () => Effect.void,
          start: () => Effect.die("Startup must not prepare the simulator"),
        },
      }).pipe(
        Layer.provide(Layer.merge(storeLayer, makeFlowCatalogLayer({ root })))
      );
      const sessionId = yield* Effect.scoped(
        Effect.gen(function* listInProcess() {
          const workspace = yield* IosWorkspace;
          const started = yield* workspace.execute(
            {
              _tag: "start",
              flowName: FlowName.make("checkout"),
              group: "shop",
              kind: "teaching",
              operationId: OperationId.make("listed-start"),
              recordingId: null,
              selection: {
                ...selection,
                outcomes: [],
                setup: { conditions: [], kind: "restart-app" },
              },
            },
            "user"
          );
          expect((yield* workspace.list()).map(({ id }) => id)).toEqual([
            started.id,
          ]);
          yield* workspace.execute(
            {
              _tag: "close",
              operationId: OperationId.make("listed-close"),
              sessionId: started.id,
            },
            "user"
          );
          expect(yield* workspace.list()).toEqual([]);
          return started.id;
        }).pipe(Effect.provide(workspaceLayer))
      );
      // After a restart the ended session is readable by id but not listed.
      const [listed, reopened] = yield* Effect.scoped(
        Effect.gen(function* afterRestart() {
          const workspace = yield* IosWorkspace;
          return yield* Effect.all([
            workspace.list(),
            workspace.execute({ _tag: "read", sessionId }, "user"),
          ]);
        }).pipe(Effect.provide(workspaceLayer))
      );
      expect(listed).toEqual([]);
      expect(reopened.phase).toBe("closed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "an iOS recording takes its uploaded .app and drops it when nothing was recorded",
  () =>
    Effect.gen(function* recordingTakesApp() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const uploads = yield* fs.makeTempDirectoryScoped();
      const upload = path.join(uploads, "Login.app");
      yield* fs.makeDirectory(upload);
      yield* fs.writeFileString(path.join(upload, "Login"), "binary");
      const installs: (string | undefined)[] = [];
      // One uploaded .app, claimable once, as the build service hands it out.
      let claimed = false;
      const builds = Layer.succeed(TargetAppBuilds, {
        claim: (_platform, buildPath) => {
          if (claimed || buildPath !== upload) {
            return Effect.fail(targetAppBuildError("build_unknown"));
          }
          claimed = true;
          return Effect.succeed({ path: upload, sha256: null });
        },
        discard: () => Effect.void,
        receiveAndroid: () => Effect.die("No Android uploads."),
        receiveIos: () => Effect.die("Uploads arrive through the route."),
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const workspaceLayer = makeIosWorkspaceLayer({
        root: () => root,
        runDeps: {
          installedBuild: (input) =>
            Effect.sync(() => {
              installs.push(input.appPath);
              return null;
            }),
          preflight: () => Effect.void,
          restart: () => Effect.void,
          start: () => Effect.die("Startup must not prepare the simulator"),
        },
      }).pipe(
        Layer.provide(
          Layer.mergeAll(storeLayer, makeFlowCatalogLayer({ root }), builds)
        )
      );
      yield* Effect.gen(function* teachWithApp() {
        const workspace = yield* IosWorkspace;
        const store = yield* TeachingRecordingStore;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName: FlowName.make("login"),
            kind: "teaching",
            operationId: OperationId.make("app-start"),
            recordingId: null,
            selection: {
              ...selection,
              appPath: upload,
              outcomes: [],
              setup: { conditions: [], kind: "restart-app" },
            },
          },
          "user"
        );
        if (started.recordingId === null) {
          return yield* Effect.die("Teaching must own a recording");
        }
        const taught = path.join(
          store.directory(started.recordingId),
          "target-app",
          "Login.app"
        );
        // The run installs the .app from the recording it now belongs to.
        expect(installs).toEqual([taught]);
        expect(yield* fs.exists(upload)).toBe(false);
        expect(yield* fs.readFileString(path.join(taught, "Login"))).toBe(
          "binary"
        );
        expect(
          (yield* store.read(started.recordingId)).targetAppBuild
        ).toMatchObject({ platform: "ios", sha256: null });
        yield* workspace.execute(
          {
            _tag: "close",
            operationId: OperationId.make("app-close"),
            sessionId: started.id,
          },
          "user"
        );
        expect(yield* fs.exists(taught)).toBe(false);
        expect(
          (yield* store.read(started.recordingId)).targetAppBuild
        ).toBeUndefined();
      }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const fakeIosStream = (): IosDeviceStream => ({
  access: { path: "/ios/stream/fixture", token: "fixture" },
  authorized: () => false,
  begin: () => Effect.succeed(true),
  close: () => Effect.void,
  end: () => Effect.succeed(null),
  frames: Stream.empty,
  integrity: () => null,
  recover: () => Effect.sync((): undefined => {}),
  start: () => Effect.sync((): undefined => {}),
});

const iosScreenshot = () => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(1206, 16);
  bytes.writeUInt32BE(2622, 20);
  return bytes.toString("base64");
};

it.effect(
  "produces the app-installation and environment-permission decisions on an iOS Dry Run whose Target App build differs from the taught one",
  () =>
    Effect.gen(function* dryRunBuildDifference() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const uploads = yield* fs.makeTempDirectoryScoped();
      const upload = path.join(uploads, "Login-v2.app");
      yield* fs.makeDirectory(upload);
      yield* fs.writeFileString(path.join(upload, "Login"), "v2-binary");

      let generation = 0;
      const capture = (device: IosObservation["device"]) =>
        Effect.sync((): IosObservation => {
          generation += 1;
          return {
            appId: selection.environment.bundleId,
            backendSessionId: "ios-build-diff",
            device,
            generation,
            id: `ios-obs-${generation}`,
            nodes: [
              {
                covered: false,
                editable: false,
                hittable: true,
                name: "Login fixture",
                packageName: selection.environment.bundleId,
                password: false,
                role: "text",
                target: `@e1~s${generation}`,
              },
              {
                covered: false,
                editable: false,
                hittable: true,
                name: "Signed in",
                packageName: selection.environment.bundleId,
                password: false,
                role: "text",
                target: `@e2~s${generation}`,
              },
            ],
            platform: "ios",
            screenshot: {
              capturedAt: "2026-11-25T00:00:00.000Z",
              encoding: "base64",
              format: "png",
              image: iosScreenshot(),
            },
          };
        });

      const builds = Layer.succeed(TargetAppBuilds, {
        claim: (_platform, buildPath) =>
          buildPath === upload
            ? Effect.succeed({ path: upload, sha256: null })
            : Effect.fail(targetAppBuildError("build_unknown")),
        discard: () => Effect.void,
        receiveAndroid: () => Effect.die("No Android uploads."),
        receiveIos: () => Effect.die("Uploads arrive through the route."),
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const learningLayer = TeachingRecordingLearningLive.pipe(
        Layer.provideMerge(storeLayer)
      );
      let installed = "1";
      const workspaceLayer = makeIosWorkspaceLayer({
        acquireStream: () => Effect.succeed(fakeIosStream()),
        booted: () => Effect.succeed(true),
        makeHid: () => Effect.succeed({ forward: () => Effect.void }),
        root: () => root,
        runDeps: {
          installedBuild: () => Effect.succeed(installed),
          preflight: () => Effect.void,
          restart: () => Effect.void,
          start: (startup) =>
            adaptNativeAppRuntime({
              backend: {
                activate: () => Effect.void,
                capture: () => capture(startup.device),
                close: () => Effect.void,
                fill: () =>
                  Effect.succeed({
                    confirmation: "confirmed",
                    outcome: "entered",
                  }),
                recover: () => Effect.void,
                rotate: () => Effect.void,
                sessionId: "ios-build-diff",
                systemKey: () => Effect.void,
                validate: () => Effect.void,
              },
              capabilities: iosCapabilities,
              error: iosRuntimeError,
              policy: nativeAppActionPolicy(iosRuntimeError, iosSystemKeys),
              startup,
            }),
        },
        simctl: () => Effect.succeed("light"),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(storeLayer, makeFlowCatalogLayer({ root }), builds)
        )
      );

      yield* Effect.gen(function* teachThenDryRunWithNewBuild() {
        const workspace = yield* IosWorkspace;
        const store = yield* TeachingRecordingStore;
        const learning = yield* TeachingRecordingLearning;
        const flowName = FlowName.make("ios-login-build");

        // Teach with an uploaded .app build ("1"); the recording retains it.
        const taughtStart = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "teaching",
            operationId: OperationId.make("diff-teach-start"),
            recordingId: null,
            selection: { ...selection, appPath: upload },
          },
          "user"
        );
        for (const decision of taughtStart.preparation.pending) {
          yield* workspace.execute(
            {
              _tag: "decide",
              allow: true,
              decisionId: decision.id,
              operationId: OperationId.make(`diff-teach-decide-${decision.id}`),
              sessionId: taughtStart.id,
            },
            "user"
          );
        }
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: OperationId.make("diff-teach-prepare"),
            sessionId: taughtStart.id,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "record",
            operationId: OperationId.make("diff-teach-record"),
            sessionId: taughtStart.id,
            start: true,
          },
          "user"
        );
        const stopped = yield* workspace.execute(
          {
            _tag: "record",
            operationId: OperationId.make("diff-teach-stop"),
            sessionId: taughtStart.id,
            start: false,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "close",
            operationId: OperationId.make("diff-teach-close"),
            sessionId: taughtStart.id,
          },
          "user"
        );
        if (stopped.recordingId === null) {
          return yield* Effect.die("Teaching must own a recording");
        }
        const claimOp = OperationId.make("diff-claim");
        yield* store.startLearning({
          operationId: claimOp,
          recordingId: stopped.recordingId,
        });
        yield* learning.save({
          claimOperationId: claimOp,
          files: [
            {
              content:
                "---\nname: ios-login-build\ndescription: Verify login build.\ninputs:\n---\n\n# Login\n\n1. Check Login fixture. Done when: Signed in is visible.\n",
              path: "flow.md",
            },
          ],
          operationId: OperationId.make("diff-save"),
          recordingId: stopped.recordingId,
        });

        // Start a Dry Run on a simulator whose installed build ("3") differs
        // from both the taught build ("1") and the selected build ("2"); the
        // recording's .app triggers the app-installation decision automatically.
        installed = "3";
        const dryRun = yield* workspace.execute(
          {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: OperationId.make("diff-dry-start"),
            recordingId: stopped.recordingId,
            selection: {
              ...selection,
              environment: { ...selection.environment, build: "2" },
            },
          },
          "agent"
        );
        expect(
          dryRun.preparation.pending.map((decision) => decision.kind)
        ).toEqual(["run-environment-permission", "app-installation"]);
        expect(dryRun.preparation.pending).toMatchObject([
          {
            differences: [{ field: "build", selected: "2", taught: "1" }],
            kind: "run-environment-permission",
            targetApp: selection.environment.bundleId,
          },
          {
            installedBuild: "3",
            kind: "app-installation",
            targetApp: selection.environment.bundleId,
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(storeLayer, learningLayer, workspaceLayer)
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
