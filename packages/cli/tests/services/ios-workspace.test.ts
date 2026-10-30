import {
  IosWorkspaceCommand,
  IosObservationRefusal,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";

import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import {
  IosWorkspace,
  iosWorkspaceRefusal,
  makeIosWorkspaceLayer,
} from "../../src/services/ios-workspace.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const selection = {
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
