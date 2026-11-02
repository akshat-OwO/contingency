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
import { Effect, FileSystem, Layer } from "effect";

import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import {
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const recordingId = TeachingRecordingId.make("recording-invalid-package");
const flowSkillName = FlowSkillName.make("set-delivery-area");
const claimOperationId = OperationId.make("invalid-package-claim");

const PREVIOUS_SKILL = "# The package that was already saved\n";

it.effect(
  "refuses a package that breaks the contract and leaves the previous one in place",
  () =>
    Effect.gen(function* refuseUncontractedPackage() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-invalid-package-",
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const layer = Layer.mergeAll(
        storeLayer,
        TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
      ).pipe(Layer.provideMerge(NodeServices.layer));

      const skillDirectory = path.join(root, flowSkillName);
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "flow.md"),
        PREVIOUS_SKILL
      );

      const { failure, lifecycle } = yield* Effect.gen(
        function* saveAnUncontractedPackage() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          const now = new Date().toISOString();
          const begun = yield* store.begin({
            emulation: {
              permissions: [],
              userAgentProfile: UserAgentProfileId.make("default"),
              viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
            },
            flowSkillName,
            operationId: OperationId.make("invalid-package-begin"),
            recordingId,
            sessionId: AgentSessionId.make("agent-invalid-package"),
          });
          yield* store.start({
            emulation: begun.emulation,
            operationId: OperationId.make("invalid-package-start"),
            recordingId,
          });
          yield* fileSystem.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            `${JSON.stringify({ _tag: "instruction", at: now, seq: 0, text: "Set the delivery area." })}\n`
          );
          yield* store.stop({
            artifacts: [
              {
                capturedAt: now,
                hash: ContentHash.make(
                  "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                ),
                id: "events",
                kind: "events",
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("invalid-package-stop"),
            recordingId,
          });
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          const refused = yield* Effect.flip(
            learning.save({
              claimOperationId,
              files: [
                {
                  content:
                    '---\nname: some-other-flow\ndescription:\n---\n\n# Set the delivery area\n\n1. Choose the button named "Confirm delivery area".\n',
                  path: "flow.md",
                },
              ],
              operationId: OperationId.make("invalid-package-save"),
              recordingId,
            })
          );
          const manifest = yield* store.read(recordingId);
          return { failure: refused, lifecycle: manifest.lifecycle._tag };
        }
      ).pipe(Effect.provide(layer));

      expect(failure.code).toBe("teaching_recording_invalid");
      expect(failure.diagnostics.map((entry) => entry.code)).toEqual([
        "flow_skill_name_mismatch",
        "flow_skill_missing_description",
        "flow_skill_missing_completion_condition",
      ]);
      expect(
        failure.diagnostics.every((entry) => entry.path[0] === "flow.md")
      ).toBe(true);
      // Nothing was staged, so the recording is still claimed rather than
      // drafted, and the package on disk is the one that was already there.
      expect(lifecycle).toBe("learning");
      expect(
        yield* fileSystem.readFileString(path.join(skillDirectory, "flow.md"))
      ).toBe(PREVIOUS_SKILL);
      expect(
        yield* fileSystem.exists(path.join(root, ".flow-skill.lock"))
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const scenario of ["duplicate", "runs", "recordings", "nested"]) {
  it.effect(
    `refuses saving a ${scenario} Flow without changing the catalog`,
    () =>
      Effect.gen(function* refuseInvalidLayout() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const name =
          scenario === "runs" || scenario === "recordings" ? scenario : "guest";
        const content = `---\nname: ${name}\ndescription: Open the store.\n---\n1. Open the store. Done when: the store is visible.\n`;
        if (scenario === "duplicate") {
          yield* fs.makeDirectory(path.join(root, "shop", name), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(root, "shop", name, "flow.md"),
            content
          );
        }
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const layer = Layer.mergeAll(
          storeLayer,
          TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
        );
        yield* Effect.gen(function* save() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          const beginInput = {
            emulation: null,
            flowSkillName: FlowSkillName.make(name),
            operationId: OperationId.make("layout-begin"),
            recordingId,
            sessionId: AgentSessionId.make("agent-layout-session"),
          };
          if (scenario !== "nested") {
            const refused = yield* Effect.flip(store.begin(beginInput));
            expect(refused.code).toBe("teaching_recording_invalid");
            expect(yield* fs.exists(path.join(root, name))).toBe(false);
            return;
          }
          const begun = yield* store.begin(beginInput);
          yield* store.start({
            emulation: begun.emulation,
            operationId: OperationId.make("layout-start"),
            recordingId,
          });
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            ""
          );
          yield* store.stop({
            artifacts: [
              {
                capturedAt: "2026-11-02",
                hash: ContentHash.make(`sha256-${"a".repeat(64)}`),
                id: "events",
                kind: "events",
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("layout-stop"),
            recordingId,
          });
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          const files = [{ content, path: "flow.md" }];
          if (scenario === "nested") {
            files.push({ content, path: "references/child/flow.md" });
          }
          const error = yield* Effect.flip(
            learning.save({
              claimOperationId,
              files,
              operationId: OperationId.make("layout-save"),
              recordingId,
            })
          );
          expect(error.code).toBe("teaching_recording_invalid");
          expect(yield* fs.exists(path.join(root, name, "flow.md"))).toBe(
            false
          );
          expect(yield* fs.exists(path.join(root, ".flow-skill.lock"))).toBe(
            false
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer))
  );
}
