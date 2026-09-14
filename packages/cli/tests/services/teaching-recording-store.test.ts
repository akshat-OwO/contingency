import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  AgentSessionId,
  FlowSkillName,
  EvidenceHash,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const executeFile = promisify(execFile);
const recordingId = TeachingRecordingId.make("recording-store-test");
const sessionId = AgentSessionId.make("agent-store-test");
const at = "2026-09-13T10:00:00.000Z";
const emulation = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("default"),
  viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
};

const layerFor = (root: string) =>
  makeTeachingRecordingStoreLayer({
    now: () => new Date(at),
    root: () => root,
  }).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "start, stop, and cleanup retries converge without duplicate state",
  () =>
    Effect.gen(function* retryTeachingLifecycle() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-store-",
      });
      const artifactDirectory = path.join(
        root,
        TEACHING_RECORDINGS_DIRECTORY,
        recordingId
      );
      const artifactFile = path.join(artifactDirectory, "keyframe-1.png");
      const exercise = Effect.gen(function* exerciseStore() {
        const store = yield* TeachingRecordingStore;
        const begin = {
          emulation,
          flowSkillName: FlowSkillName.make("checkout-flow"),
          operationId: OperationId.make("begin-once"),
          recordingId,
          sessionId,
        };
        yield* store.begin(begin);
        yield* store.begin(begin);
        const start = {
          operationId: OperationId.make("start-once"),
          recordingId,
        };
        yield* store.start(start);
        yield* store.start(start);
        const extraStart = yield* Effect.flip(
          store.start({
            operationId: OperationId.make("start-again"),
            recordingId,
          })
        );
        expect(extraStart.code).toBe("teaching_recording_conflict");
        yield* fileSystem.writeFileString(artifactFile, "one keyframe");
        const stop = {
          artifacts: [
            {
              capturedAt: at,
              hash: EvidenceHash.make(
                "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              ),
              id: "keyframe-1",
              kind: "keyframe" as const,
              path: "keyframe-1.png",
            },
          ],
          operationId: OperationId.make("stop-once"),
          recordingId,
        };
        yield* store.stop(stop);
        yield* store.stop(stop);
        const extraStop = yield* Effect.flip(
          store.stop({
            artifacts: [],
            operationId: OperationId.make("stop-again"),
            recordingId,
          })
        );
        expect(extraStop.code).toBe("teaching_recording_conflict");
        const prematureVerification = yield* Effect.flip(
          store.verify({
            operationId: OperationId.make("verification-too-soon"),
            recordingId,
          })
        );
        const prematureCleanup = yield* Effect.flip(
          store.cleanup({
            operationId: OperationId.make("cleanup-too-soon"),
            recordingId,
          })
        );
        expect(prematureVerification.code).toBe("teaching_recording_conflict");
        expect(prematureCleanup.code).toBe("teaching_recording_conflict");
        yield* store.startLearning({
          operationId: OperationId.make("learning-once"),
          recordingId,
        });
        yield* store.saveSkill({
          operationId: OperationId.make("save-skill-once"),
          recordingId,
          skillPath: "checkout-flow/SKILL.md",
        });
        yield* store.startDryRun({
          operationId: OperationId.make("dry-run-once"),
          recordingId,
        });
        yield* store.passDryRun({
          operationId: OperationId.make("dry-run-pass-once"),
          recordingId,
        });
        const verification = {
          operationId: OperationId.make("verification-once"),
          recordingId,
        };
        yield* store.verify(verification);
        yield* store.verify(verification);
        const cleanup = {
          operationId: OperationId.make("cleanup-once"),
          recordingId,
        };
        yield* store.cleanup(cleanup);
        const cleaned = yield* store.cleanup(cleanup);
        const duplicateCleanup = yield* Effect.flip(
          store.cleanup({
            operationId: OperationId.make("cleanup-again"),
            recordingId,
          })
        );
        return { cleaned, duplicateCleanup };
      }).pipe(Effect.provide(layerFor(root)));

      const { cleaned, duplicateCleanup } = yield* exercise;
      expect(cleaned.cleanup._tag).toBe("completed");
      expect(cleaned.lifecycle._tag).toBe("verified");
      expect(duplicateCleanup.code).toBe("teaching_recording_conflict");
      expect(cleaned.receipts.map((receipt) => receipt.operation)).toEqual([
        "begin",
        "start",
        "stop",
        "start-learning",
        "save-skill",
        "start-dry-run",
        "pass-dry-run",
        "verification",
        "cleanup",
      ]);
      expect(yield* fileSystem.exists(artifactFile)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "retains artifacts when capture stops with a recoverable failure",
  () =>
    Effect.gen(function* recoverableCaptureFailure() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-failure-",
      });
      const failedRecordingId = TeachingRecordingId.make(
        "recording-store-failure"
      );
      const failed = yield* Effect.gen(function* persistFailure() {
        const store = yield* TeachingRecordingStore;
        yield* store.begin({
          emulation,
          flowSkillName: FlowSkillName.make("failed-flow"),
          operationId: OperationId.make("begin-failure"),
          recordingId: failedRecordingId,
          sessionId,
        });
        yield* store.start({
          operationId: OperationId.make("start-failure"),
          recordingId: failedRecordingId,
        });
        return yield* store.stop({
          artifacts: [],
          failure: "The Teaching video encoder stopped unexpectedly.",
          operationId: OperationId.make("stop-failure"),
          recordingId: failedRecordingId,
        });
      }).pipe(Effect.provide(layerFor(root)));

      expect(failed.lifecycle).toEqual({
        _tag: "failed",
        error: "The Teaching video encoder stopped unexpectedly.",
        failedAt: at,
      });
      expect(failed.receipts.at(-1)?.operation).toBe("stop");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("a Ready manifest survives two real process lifetimes", () =>
  Effect.gen(function* restartTeachingStore() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-process-",
    });
    const helper = path.resolve(
      import.meta.dirname,
      "../helpers/teaching-recording-process.ts"
    );
    const write = yield* Effect.promise(() =>
      executeFile(
        process.execPath,
        ["--experimental-strip-types", helper, "write", root],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
        }
      )
    );
    const read = yield* Effect.promise(() =>
      executeFile(
        process.execPath,
        ["--experimental-strip-types", helper, "read", root],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
        }
      )
    );

    expect(JSON.parse(write.stdout)).toEqual({
      lifecycle: "ready",
      receipts: ["begin", "start", "stop"],
    });
    expect(JSON.parse(read.stdout)).toEqual({
      lifecycle: "ready",
      receipts: ["begin", "start", "stop"],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "a second store instance finds a Ready recording on the same Catalog Root",
  () =>
    Effect.gen(function* shareReadyRecording() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-shared-",
      });
      const create = Effect.gen(function* createFromWeb() {
        const store = yield* TeachingRecordingStore;
        yield* store.begin({
          emulation,
          flowSkillName: FlowSkillName.make("checkout-flow"),
          operationId: OperationId.make("web-begin"),
          recordingId,
          sessionId,
        });
        yield* store.start({
          operationId: OperationId.make("web-start"),
          recordingId,
        });
        yield* store.stop({
          artifacts: [],
          operationId: OperationId.make("web-stop"),
          recordingId,
        });
      }).pipe(Effect.provide(layerFor(root)));
      const discover = Effect.gen(function* discoverFromMcp() {
        const store = yield* TeachingRecordingStore;
        return yield* store.listReady();
      }).pipe(Effect.provide(layerFor(root)));

      yield* create;
      const ready = yield* discover;

      expect(ready.map((manifest) => manifest.recordingId)).toEqual([
        recordingId,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("keeps an active recording under its original Catalog Root", () =>
  Effect.gen(function* pinRecordingRoot() {
    const fileSystem = yield* FileSystem.FileSystem;
    const firstRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-first-root-",
    });
    const secondRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-second-root-",
    });
    let selectedRoot = firstRoot;
    const activeLayer = makeTeachingRecordingStoreLayer({
      now: () => new Date(at),
      root: () => selectedRoot,
    }).pipe(Layer.provideMerge(NodeServices.layer));
    yield* Effect.gen(function* finishAcrossRootChange() {
      const store = yield* TeachingRecordingStore;
      yield* store.begin({
        emulation,
        flowSkillName: FlowSkillName.make("checkout-flow"),
        operationId: OperationId.make("root-begin"),
        recordingId,
        sessionId,
      });
      yield* store.start({
        operationId: OperationId.make("root-start"),
        recordingId,
      });
      selectedRoot = secondRoot;
      yield* store.stop({
        artifacts: [],
        operationId: OperationId.make("root-stop"),
        recordingId,
      });
    }).pipe(Effect.provide(activeLayer));

    const firstReady = yield* Effect.gen(function* readFirstRoot() {
      const store = yield* TeachingRecordingStore;
      return yield* store.listReady();
    }).pipe(Effect.provide(layerFor(firstRoot)));
    const secondReady = yield* Effect.gen(function* readSecondRoot() {
      const store = yield* TeachingRecordingStore;
      return yield* store.listReady();
    }).pipe(Effect.provide(layerFor(secondRoot)));

    expect(firstReady.map((manifest) => manifest.recordingId)).toEqual([
      recordingId,
    ]);
    expect(secondReady).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "stop recovers a finalizing manifest into ready without a second write of that tag",
  () =>
    Effect.gen(function* resumeFinalizingManifest() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-finalizing-",
      });
      const directory = path.join(
        root,
        TEACHING_RECORDINGS_DIRECTORY,
        recordingId
      );
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(directory, "manifest.json"),
        `${JSON.stringify({
          artifacts: [],
          cleanup: { _tag: "pending" },
          createdAt: at,
          emulation,
          flowSkillName: "checkout-flow",
          lifecycle: { _tag: "finalizing", startedAt: at, stoppedAt: at },
          receipts: [
            {
              completedAt: at,
              operation: "begin",
              operationId: "begin-once",
            },
            {
              completedAt: at,
              operation: "start",
              operationId: "start-once",
            },
          ],
          recordingId,
          schemaVersion: 1,
          sessionId,
          updatedAt: at,
        })}\n`
      );
      const ready = yield* Effect.gen(function* stopFinalizing() {
        const store = yield* TeachingRecordingStore;
        return yield* store.stop({
          artifacts: [],
          operationId: OperationId.make("stop-resume"),
          recordingId,
        });
      }).pipe(Effect.provide(layerFor(root)));

      expect(ready.lifecycle._tag).toBe("ready");
      expect(ready.sessionId).toBe(sessionId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
