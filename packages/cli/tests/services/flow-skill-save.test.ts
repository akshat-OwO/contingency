import path from "node:path";

import {
  AgentSessionId,
  EvidenceHash,
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
        path.join(skillDirectory, "SKILL.md"),
        PREVIOUS_SKILL
      );

      const { failure, lifecycle } = yield* Effect.gen(
        function* saveAnUncontractedPackage() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          const now = new Date().toISOString();
          yield* store.begin({
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
                hash: EvidenceHash.make(
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
                  path: "SKILL.md",
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
        failure.diagnostics.every((entry) => entry.path[0] === "SKILL.md")
      ).toBe(true);
      // Nothing was staged, so the recording is still claimed rather than
      // drafted, and the package on disk is the one that was already there.
      expect(lifecycle).toBe("learning");
      expect(
        yield* fileSystem.readFileString(path.join(skillDirectory, "SKILL.md"))
      ).toBe(PREVIOUS_SKILL);
      expect(
        yield* fileSystem.exists(path.join(root, ".flow-skill.lock"))
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
