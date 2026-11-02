import path from "node:path";

import {
  IosWorkspaceCommand,
  FlowSkillName,
  OperationId,
  IosObservationRefusal,
} from "@contingency/protocol";
import type { IosWorkspaceSelection } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import type { Mutable } from "effect/Types";

import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import type {
  IosRunInput,
  IosObservation,
} from "../../src/services/ios-runtime.ts";
import {
  IosWorkspace,
  iosWorkspaceRefusal,
  makeIosWorkspaceLayer,
} from "../../src/services/ios-workspace.ts";
import type { NativeAppRunDecision } from "../../src/services/native-app-run-contract.ts";
import { createNativeAppRun } from "../../src/services/native-app-run.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
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
        flowSkillName: "ios-login",
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
          Layer.provide(Layer.merge(store, makeFlowSkillCatalogLayer({ root })))
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
  expect(iosWorkspaceRefusal("foreign_app_foreground")).toEqual({
    code: "foreign_app_foreground",
    recovery: "return-to-target-app",
  });
  expect(iosWorkspaceRefusal("runtime_failed")).toBe(null);
});

it("keeps each iOS refusal bound to its recovery command", () => {
  const decode = Schema.decodeUnknownResult(IosObservationRefusal);
  expect(decode(iosWorkspaceRefusal("capture_incomplete"))._tag).toBe(
    "Success"
  );
  expect(
    decode({ code: "capture_incomplete", recovery: "return-to-target-app" })
      ._tag
  ).toBe("Failure");
  expect(
    decode({ code: "foreign_app_foreground", recovery: "recover" })._tag
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
          createRun: (input) =>
            createNativeAppRun<
              IosRunInput,
              IosObservation,
              NativeAppRunDecision
            >(input, {
              authorize: (request) => request,
              decisions: () => [],
              differences: () => [],
              error: platformRuntimeError,
              preflight: () => Effect.void,
              start: () => Effect.die("Startup must not prepare the simulator"),
              startingConditions: () => true,
              validate: () => Effect.void,
            }),
          root: () => root,
        }).pipe(
          Layer.provide(
            Layer.merge(storeLayer, makeFlowSkillCatalogLayer({ root }))
          )
        );
        yield* Effect.gen(function* startInGroup() {
          const workspace = yield* IosWorkspace;
          const store = yield* TeachingRecordingStore;
          const command: Mutable<
            Extract<IosWorkspaceCommand, { _tag: "start" }>
          > = {
            _tag: "start",
            flowSkillName: FlowSkillName.make("checkout"),
            kind: "teaching",
            operationId: OperationId.make("grouped-start"),
            recordingId: null,
            selection,
          };
          if (!existing) {
            command.group = "shop";
          }
          const started = yield* workspace.execute(command, "user");
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching must own a recording");
          }
          expect(store.directory(started.recordingId)).toBe(
            path.join(owner, "recordings", started.recordingId)
          );
          expect(yield* fs.exists(path.join(root, "checkout"))).toBe(false);
          expect((yield* store.read(started.recordingId)).flowSkillName).toBe(
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
        }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
