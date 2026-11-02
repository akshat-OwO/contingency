import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { TeachingRecordingToolHandlersLive } from "../../src/services/mcp-teaching-recording.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import { teachingRecordingTool } from "../integration/agent-harness.ts";

for (const platform of ["android", "ios"] as const) {
  it.effect(
    `blocks saves during an active ${platform} Run and permits saving after it ends`,
    () =>
      Effect.gen(function* nativeSaveGuard() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const recordingId = TeachingRecordingId.make("recording-native-save");
        const claimOperationId = OperationId.make("claim");
        let active = false;
        const activeRunFlowNames = () =>
          Effect.sync(() => (active ? ["cart"] : []));
        const native =
          platform === "android"
            ? Layer.mock(AndroidWorkspace, { activeRunFlowNames })
            : Layer.mock(IosWorkspace, { activeRunFlowNames });
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const dependencies = Layer.mergeAll(
          storeLayer,
          native,
          Layer.mock(AgentSession, { list: () => Effect.succeed([]) })
        );
        yield* Effect.gen(function* saveAroundRun() {
          const store = yield* TeachingRecordingStore;
          const emulation = {
            permissions: [],
            userAgentProfile: UserAgentProfileId.make("default"),
            viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
          };
          yield* store.begin({
            emulation,
            flowSkillName: FlowSkillName.make("cart"),
            operationId: OperationId.make("begin"),
            recordingId,
            sessionId: AgentSessionId.make("agent-native-save"),
          });
          yield* store.start({
            emulation,
            operationId: OperationId.make("start"),
            recordingId,
          });
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "recording.webm"),
            "video"
          );
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            ""
          );
          yield* store.stop({
            artifacts: [
              {
                capturedAt: new Date().toISOString(),
                hash: ContentHash.make(
                  "sha256-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                ),
                id: "events",
                kind: "events",
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("stop"),
            recordingId,
          });
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          const save = (description: string, operation: string) =>
            teachingRecordingTool("agent_flow_skill_save", {
              claimOperationId,
              files: [
                {
                  content: `---\nname: cart\ndescription: ${description}\ninputs:\n---\n1. Open cart. Done when: cart is visible.\n`,
                  path: "flow.md",
                },
              ],
              operationId: OperationId.make(operation),
              recordingId,
            });
          yield* save("Original cart", "initial");
          const file = path.join(root, "cart", "flow.md");
          const original = yield* fs.readFileString(file);
          active = true;
          const refused = yield* Effect.result(save("Changed cart", "blocked"));
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused)) {
            expect(refused.failure.message).toContain(
              "An active Run uses this Flow"
            );
            expect(refused.failure.code).toBe("teaching_recording_conflict");
          }
          expect(yield* fs.readFileString(file)).toBe(original);
          active = false;
          yield* save("Changed cart", "after-run");
          expect(yield* fs.readFileString(file)).toContain("Changed cart");
        }).pipe(
          Effect.provide(
            TeachingRecordingToolHandlersLive.pipe(
              Layer.provideMerge(dependencies)
            )
          )
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
