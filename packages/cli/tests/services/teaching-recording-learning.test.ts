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

const recordingId = TeachingRecordingId.make("recording-large-timeline");

it.effect(
  "refuses one timeline event larger than the documented page budget",
  () =>
    Effect.gen(function* refuseOversizedTimelineEvent() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-large-timeline-",
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const layer = Layer.mergeAll(
        storeLayer,
        TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
      ).pipe(Layer.provideMerge(NodeServices.layer));

      const failure = yield* Effect.gen(function* prepareLargeTimeline() {
        const store = yield* TeachingRecordingStore;
        const learning = yield* TeachingRecordingLearning;
        const now = new Date().toISOString();
        yield* store.begin({
          emulation: {
            permissions: [],
            userAgentProfile: UserAgentProfileId.make("default"),
            viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
          },
          flowSkillName: FlowSkillName.make("large-timeline"),
          operationId: OperationId.make("large-begin"),
          recordingId,
          sessionId: AgentSessionId.make("agent-large-timeline"),
        });
        yield* store.start({
          operationId: OperationId.make("large-start"),
          recordingId,
        });
        const eventFile = path.join(
          store.directory(recordingId),
          "events.jsonl"
        );
        yield* fileSystem.writeFileString(
          eventFile,
          `${JSON.stringify({
            _tag: "instruction",
            at: now,
            seq: 0,
            text: "x".repeat(70_000),
          })}\n`
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
          operationId: OperationId.make("large-stop"),
          recordingId,
        });
        const claimOperationId = OperationId.make("large-claim");
        yield* store.startLearning({
          operationId: claimOperationId,
          recordingId,
        });
        return yield* Effect.flip(
          learning.timeline({ claimOperationId, cursor: 0, recordingId })
        );
      }).pipe(Effect.provide(layer));

      expect(failure.code).toBe("teaching_timeline_too_large");
      expect(failure.message).toContain("65536-character");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
