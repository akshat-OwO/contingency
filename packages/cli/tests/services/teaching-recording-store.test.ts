import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  AgentSessionId,
  FlowSkillName,
  ContentHash,
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
              hash: ContentHash.make(
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
        const drafted = yield* store.saveSkill({
          claimOperationId: OperationId.make("learning-once"),
          files: ["SKILL.md"],
          operationId: OperationId.make("save-skill-once"),
          recordingId,
          skillPath: "checkout-flow/SKILL.md",
        });
        expect(
          drafted.receipts.find((receipt) => receipt.operation === "save-skill")
            ?.files
        ).toEqual(["SKILL.md"]);
        yield* store.startDryRun({
          inputs: [{ changed: true, name: "city", value: "Pune" }],
          operationId: OperationId.make("dry-run-once"),
          recordingId,
          sessionId,
        });
        yield* store.passDryRun({
          observableOutcome: "The delivery area is Pune.",
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
        expect(yield* fileSystem.exists(artifactDirectory)).toBe(false);
        const duplicateCleanup = yield* Effect.flip(
          store.cleanup({
            operationId: OperationId.make("cleanup-again"),
            recordingId,
          })
        );
        return { cleaned, duplicateCleanup };
      }).pipe(Effect.provide(layerFor(root)));

      const { cleaned, duplicateCleanup } = yield* exercise;
      expect(cleaned.cleanup._tag).toBe("purged");
      expect(cleaned.lifecycle._tag).toBe("verified");
      expect(duplicateCleanup.code).toBe("teaching_recording_not_found");
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
      expect(
        yield* fileSystem.readFileString(
          path.join(root, "checkout-flow", "references", "verification.md")
        )
      ).toContain(`- Verified: ${at}`);
      expect(yield* fileSystem.exists(artifactDirectory)).toBe(false);
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

it.effect(
  "keeps Teaching evidence after Dry Run failure, pass, and rejection",
  () =>
    Effect.gen(function* retainUntilVerification() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-dry-run-retention-",
      });
      const retainedId = TeachingRecordingId.make(
        "recording-dry-run-retention"
      );
      const directory = path.join(
        root,
        TEACHING_RECORDINGS_DIRECTORY,
        retainedId
      );
      const artifactFile = path.join(directory, "events.jsonl");
      const skillFile = path.join(root, "delivery-flow", "SKILL.md");
      const result = yield* Effect.gen(function* exerciseDryRuns() {
        const store = yield* TeachingRecordingStore;
        yield* store.begin({
          emulation,
          flowSkillName: FlowSkillName.make("delivery-flow"),
          operationId: OperationId.make("retention-begin"),
          recordingId: retainedId,
          sessionId,
        });
        yield* store.start({
          operationId: OperationId.make("retention-start"),
          recordingId: retainedId,
        });
        yield* fileSystem.writeFileString(artifactFile, "{}\n");
        yield* store.stop({
          artifacts: [
            {
              capturedAt: at,
              hash: ContentHash.make(
                "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
              ),
              id: "events",
              kind: "events",
              path: "events.jsonl",
            },
          ],
          operationId: OperationId.make("retention-stop"),
          recordingId: retainedId,
        });
        yield* store.startLearning({
          operationId: OperationId.make("retention-learn"),
          recordingId: retainedId,
        });
        yield* fileSystem.makeDirectory(path.dirname(skillFile), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(skillFile, "# Delivery flow\n");
        yield* store.saveSkill({
          claimOperationId: OperationId.make("retention-learn"),
          files: ["SKILL.md"],
          operationId: OperationId.make("retention-save"),
          recordingId: retainedId,
          skillPath: "delivery-flow/SKILL.md",
        });
        yield* store.startDryRun({
          inputs: [{ changed: true, name: "city", value: "Pune" }],
          operationId: OperationId.make("retention-dry-one"),
          recordingId: retainedId,
          sessionId,
        });
        const failed = yield* store.failDryRun({
          observableOutcome: "The delivery area did not change.",
          operationId: OperationId.make("retention-fail"),
          recordingId: retainedId,
        });
        expect(failed.lifecycle._tag).toBe("dry-run-failed");
        expect(yield* fileSystem.exists(artifactFile)).toBe(true);

        yield* store.startDryRun({
          inputs: [{ changed: true, name: "city", value: "Mumbai" }],
          operationId: OperationId.make("retention-dry-two"),
          recordingId: retainedId,
          sessionId,
        });
        const passed = yield* store.passDryRun({
          observableOutcome: "The delivery area changed to Mumbai.",
          operationId: OperationId.make("retention-pass"),
          recordingId: retainedId,
        });
        expect(passed.lifecycle._tag).toBe("dry-run-passed");
        expect(yield* fileSystem.exists(artifactFile)).toBe(true);
        const rejected = yield* store.reject({
          operationId: OperationId.make("retention-reject"),
          recordingId: retainedId,
        });
        return rejected;
      }).pipe(Effect.provide(layerFor(root)));

      expect(result.lifecycle._tag).toBe("skill-drafted");
      expect(yield* fileSystem.exists(artifactFile)).toBe(true);
      expect(
        yield* fileSystem.readFileString(
          path.join(root, "delivery-flow", "references", "verification.md")
        )
      ).toContain("Mumbai");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("retries purge-pending cleanup when a store starts", () =>
  Effect.gen(function* recoverPurgePending() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-purge-recovery-",
    });
    const recoveryId = TeachingRecordingId.make("recording-purge-recovery");
    const directory = path.join(
      root,
      TEACHING_RECORDINGS_DIRECTORY,
      recoveryId
    );
    const artifactFile = path.join(directory, "recording.webm");
    yield* Effect.gen(function* leavePurgePending() {
      const store = yield* TeachingRecordingStore;
      yield* store.begin({
        emulation,
        flowSkillName: FlowSkillName.make("recovery-flow"),
        operationId: OperationId.make("recovery-begin"),
        recordingId: recoveryId,
        sessionId,
      });
      yield* store.start({
        operationId: OperationId.make("recovery-start"),
        recordingId: recoveryId,
      });
      yield* fileSystem.writeFileString(artifactFile, "video");
      yield* store.stop({
        artifacts: [
          {
            capturedAt: at,
            hash: ContentHash.make(
              "sha256-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            ),
            id: "video",
            kind: "video",
            path: "recording.webm",
          },
        ],
        operationId: OperationId.make("recovery-stop"),
        recordingId: recoveryId,
      });
      yield* store.startLearning({
        operationId: OperationId.make("recovery-learn"),
        recordingId: recoveryId,
      });
      yield* store.saveSkill({
        claimOperationId: OperationId.make("recovery-learn"),
        files: ["SKILL.md"],
        operationId: OperationId.make("recovery-save"),
        recordingId: recoveryId,
        skillPath: "recovery-flow/SKILL.md",
      });
      yield* store.startDryRun({
        inputs: [],
        operationId: OperationId.make("recovery-dry"),
        recordingId: recoveryId,
        sessionId,
      });
      yield* store.passDryRun({
        observableOutcome: "The flow completed.",
        operationId: OperationId.make("recovery-pass"),
        recordingId: recoveryId,
      });
      const pending = yield* store.verify({
        operationId: OperationId.make("recovery-verify"),
        recordingId: recoveryId,
      });
      expect(pending.cleanup._tag).toBe("purge-pending");
    }).pipe(Effect.provide(layerFor(root)));

    yield* Effect.gen(function* startRecoveredStore() {
      yield* TeachingRecordingStore;
    }).pipe(Effect.provide(layerFor(root)));

    expect(yield* fileSystem.exists(directory)).toBe(false);
    expect(yield* fileSystem.exists(artifactFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("keeps a verified Flow Skill retryable when cleanup fails", () =>
  Effect.gen(function* exposeCleanupFailure() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-cleanup-failure-",
    });
    const failureId = TeachingRecordingId.make("recording-cleanup-failure");
    const directory = path.join(root, TEACHING_RECORDINGS_DIRECTORY, failureId);
    const lockedDirectory = path.join(directory, "locked");
    yield* fileSystem.makeDirectory(lockedDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(lockedDirectory, "trace.zip"),
      "trace"
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "manifest.json"),
      `${JSON.stringify({
        artifacts: [],
        cleanup: {
          _tag: "purge-pending",
          failure: null,
          retainedFiles: ["locked/trace.zip"],
        },
        createdAt: at,
        emulation,
        flowSkillName: "cleanup-failure-flow",
        lifecycle: {
          _tag: "verified",
          draftedAt: at,
          dryRunEndedAt: at,
          dryRunResult: {
            completedAt: at,
            inputs: [],
            observableOutcome: "The flow completed.",
            outcome: "passed",
          },
          dryRunSessionId: sessionId,
          dryRunStartedAt: at,
          readyAt: at,
          skillPath: "cleanup-failure-flow/SKILL.md",
          startedAt: at,
          stoppedAt: at,
          verifiedAt: at,
        },
        receipts: [],
        recordingId: failureId,
        schemaVersion: 1,
        sessionId,
        updatedAt: at,
      })}\n`
    );
    yield* fileSystem.chmod(lockedDirectory, 0);

    const exercise = Effect.gen(function* retryFailedCleanup() {
      const store = yield* TeachingRecordingStore;
      const failed = yield* store.read(failureId);
      expect(failed.cleanup).toMatchObject({
        _tag: "purge-pending",
        retainedFiles: ["locked"],
      });
      yield* fileSystem.chmod(lockedDirectory, 0o700);
      return yield* store.cleanup({
        operationId: OperationId.make("cleanup-failure-retry"),
        recordingId: failureId,
      });
    }).pipe(
      Effect.provide(layerFor(root)),
      Effect.ensuring(
        fileSystem.chmod(lockedDirectory, 0o700).pipe(Effect.ignore)
      )
    );

    const cleaned = yield* exercise;
    expect(cleaned.cleanup._tag).toBe("purged");
    expect(yield* fileSystem.exists(directory)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("releases and retries failed learning claims", () =>
  Effect.gen(function* retryLearningClaim() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-learning-retry-",
    });
    const retryId = TeachingRecordingId.make("recording-learning-retry");
    yield* Effect.gen(function* exerciseRetries() {
      const store = yield* TeachingRecordingStore;
      yield* store.begin({
        emulation,
        flowSkillName: FlowSkillName.make("retry-flow"),
        operationId: OperationId.make("retry-begin"),
        recordingId: retryId,
        sessionId,
      });
      yield* store.start({
        operationId: OperationId.make("retry-start"),
        recordingId: retryId,
      });
      yield* store.stop({
        artifacts: [],
        operationId: OperationId.make("retry-stop"),
        recordingId: retryId,
      });
      yield* store.startLearning({
        operationId: OperationId.make("retry-claim-one"),
        recordingId: retryId,
      });
      const released = yield* store.releaseLearning({
        claimOperationId: OperationId.make("retry-claim-one"),
        operationId: OperationId.make("retry-release"),
        recordingId: retryId,
      });
      expect(released.lifecycle._tag).toBe("ready");

      yield* store.startLearning({
        operationId: OperationId.make("retry-claim-two"),
        recordingId: retryId,
      });
      const failed = yield* store.failLearning({
        claimOperationId: OperationId.make("retry-claim-two"),
        error: "The proposed steps were incomplete.",
        operationId: OperationId.make("retry-fail"),
        recordingId: retryId,
      });
      expect(failed.lifecycle).toMatchObject({
        _tag: "failed",
        error: "The proposed steps were incomplete.",
      });
      expect(
        (yield* store.listReady()).map((manifest) => manifest.recordingId)
      ).toContain(retryId);
      const retried = yield* store.startLearning({
        operationId: OperationId.make("retry-claim-three"),
        recordingId: retryId,
      });
      expect(retried.lifecycle._tag).toBe("learning");
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "a Ready manifest survives two real process lifetimes",
  () =>
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  15_000
);

it.effect(
  "grants one learning claim across two real processes",
  () =>
    Effect.gen(function* claimAcrossProcesses() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-claim-",
      });
      const helper = path.resolve(
        import.meta.dirname,
        "../helpers/teaching-recording-process.ts"
      );
      const cwd = path.resolve(import.meta.dirname, "../..");
      yield* Effect.promise(() =>
        executeFile(
          process.execPath,
          ["--experimental-strip-types", helper, "write", root],
          { cwd }
        )
      );
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([
          executeFile(
            process.execPath,
            ["--experimental-strip-types", helper, "claim", root, "claim-one"],
            { cwd }
          ),
          executeFile(
            process.execPath,
            ["--experimental-strip-types", helper, "claim", root, "claim-two"],
            { cwd }
          ),
        ])
      );
      const outcomes = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
      expect(
        outcomes.filter((outcome) => outcome.lifecycle === "learning")
      ).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) => outcome.code === "teaching_recording_conflict"
        )
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  15_000
);

it.effect(
  "reclaims a learning claim after its process exits",
  () =>
    Effect.gen(function* reclaimDeadLearner() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-dead-claim-",
      });
      const helper = path.resolve(
        import.meta.dirname,
        "../helpers/teaching-recording-process.ts"
      );
      const cwd = path.resolve(import.meta.dirname, "../..");
      yield* Effect.promise(() =>
        executeFile(
          process.execPath,
          ["--experimental-strip-types", helper, "write", root],
          { cwd }
        )
      );
      yield* Effect.promise(() =>
        executeFile(
          process.execPath,
          ["--experimental-strip-types", helper, "claim", root, "dead-claim"],
          { cwd }
        )
      );
      const reclaimed = yield* Effect.promise(() =>
        executeFile(
          process.execPath,
          [
            "--experimental-strip-types",
            helper,
            "claim",
            root,
            "reclaimed-claim",
          ],
          { cwd }
        )
      );
      expect(JSON.parse(reclaimed.stdout)).toEqual({ lifecycle: "learning" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  15_000
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

it.effect("renames before capture and discards a recording back to setup", () =>
  Effect.gen(function* renameAndDiscard() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-discard-",
    });
    const discardedId = TeachingRecordingId.make("recording-store-discard");
    const artifactDirectory = path.join(
      root,
      TEACHING_RECORDINGS_DIRECTORY,
      discardedId
    );
    const artifactFile = path.join(artifactDirectory, "keyframe-1.png");
    const outcome = yield* Effect.gen(function* exercise() {
      const store = yield* TeachingRecordingStore;
      yield* store.begin({
        emulation,
        flowSkillName: FlowSkillName.make("first-name"),
        operationId: OperationId.make("begin-discard"),
        recordingId: discardedId,
        sessionId,
      });
      const rename = {
        flowSkillName: FlowSkillName.make("second-name"),
        operationId: OperationId.make("rename-once"),
        recordingId: discardedId,
      };
      yield* store.rename(rename);
      const renamed = yield* store.rename(rename);
      yield* store.start({
        operationId: OperationId.make("start-discard"),
        recordingId: discardedId,
      });
      // A recording cannot be renamed once it holds captured evidence: the
      // bundle on disk is already filed under the name it began with.
      const lateRename = yield* Effect.flip(
        store.rename({
          flowSkillName: FlowSkillName.make("third-name"),
          operationId: OperationId.make("rename-late"),
          recordingId: discardedId,
        })
      );
      yield* fileSystem.writeFileString(artifactFile, "one keyframe");
      yield* store.stop({
        artifacts: [
          {
            capturedAt: at,
            hash: ContentHash.make(
              "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ),
            id: "keyframe-1",
            kind: "keyframe" as const,
            path: "keyframe-1.png",
          },
        ],
        operationId: OperationId.make("stop-discard"),
        recordingId: discardedId,
      });
      const discard = {
        operationId: OperationId.make("discard-once"),
        recordingId: discardedId,
      };
      yield* store.discard(discard);
      const discarded = yield* store.discard(discard);
      return { discarded, lateRename, renamed };
    }).pipe(Effect.provide(layerFor(root)));

    expect(outcome.renamed.flowSkillName).toBe("second-name");
    expect(outcome.lateRename.code).toBe("teaching_recording_conflict");
    expect(outcome.discarded.lifecycle._tag).toBe("setup");
    expect(outcome.discarded.artifacts).toEqual([]);
    expect(yield* fileSystem.exists(artifactFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("a learning claim outlives a failed Dry Run and a rejection", () =>
  Effect.gen(function* keepClaimThroughFailure() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-teaching-claim-lifetime-",
    });
    const claimedId = TeachingRecordingId.make("recording-claim-lifetime");
    const claim = OperationId.make("lifetime-claim");
    const skillFile = path.join(root, "lifetime-flow", "SKILL.md");
    yield* Effect.gen(function* exerciseClaimLifetime() {
      const store = yield* TeachingRecordingStore;
      yield* store.begin({
        emulation,
        flowSkillName: FlowSkillName.make("lifetime-flow"),
        operationId: OperationId.make("lifetime-begin"),
        recordingId: claimedId,
        sessionId,
      });
      yield* store.start({
        operationId: OperationId.make("lifetime-start"),
        recordingId: claimedId,
      });
      yield* store.stop({
        artifacts: [],
        operationId: OperationId.make("lifetime-stop"),
        recordingId: claimedId,
      });

      // A save needs a claim, and names the tool that grants one.
      const unclaimed = yield* Effect.result(
        store.saveSkill({
          claimOperationId: claim,
          files: ["SKILL.md"],
          operationId: OperationId.make("lifetime-save-unclaimed"),
          recordingId: claimedId,
          skillPath: "lifetime-flow/SKILL.md",
        })
      );
      expect(unclaimed).toMatchObject({
        failure: { code: "teaching_recording_unclaimed" },
      });
      if (unclaimed._tag === "Failure") {
        expect(unclaimed.failure.message).toContain(
          "agent_teaching_recording_claim"
        );
      }

      yield* store.startLearning({
        operationId: claim,
        recordingId: claimedId,
      });
      yield* fileSystem.makeDirectory(path.dirname(skillFile), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(skillFile, "# Lifetime flow\n");
      yield* store.saveSkill({
        claimOperationId: claim,
        files: ["SKILL.md"],
        operationId: OperationId.make("lifetime-save-one"),
        recordingId: claimedId,
        skillPath: "lifetime-flow/SKILL.md",
      });
      yield* store.startDryRun({
        inputs: [],
        operationId: OperationId.make("lifetime-dry-one"),
        recordingId: claimedId,
        sessionId,
      });
      yield* store.failDryRun({
        observableOutcome: "The order never reached the confirmation page.",
        operationId: OperationId.make("lifetime-fail"),
        recordingId: claimedId,
      });

      // The failure keeps the claim, so the same agent saves its fix.
      const fixed = yield* store.saveSkill({
        claimOperationId: claim,
        files: ["SKILL.md"],
        operationId: OperationId.make("lifetime-save-two"),
        recordingId: claimedId,
        skillPath: "lifetime-flow/SKILL.md",
      });
      expect(fixed.lifecycle._tag).toBe("skill-drafted");

      // Another live operation's claim id is a conflict, not a missing claim.
      const other = yield* Effect.result(
        store.saveSkill({
          claimOperationId: OperationId.make("lifetime-other-claim"),
          files: ["SKILL.md"],
          operationId: OperationId.make("lifetime-save-other"),
          recordingId: claimedId,
          skillPath: "lifetime-flow/SKILL.md",
        })
      );
      expect(other).toMatchObject({
        failure: { code: "teaching_recording_conflict" },
      });

      yield* store.startDryRun({
        inputs: [],
        operationId: OperationId.make("lifetime-dry-two"),
        recordingId: claimedId,
        sessionId,
      });
      yield* store.passDryRun({
        observableOutcome: "The confirmation page appeared.",
        operationId: OperationId.make("lifetime-pass"),
        recordingId: claimedId,
      });
      yield* store.reject({
        operationId: OperationId.make("lifetime-reject"),
        recordingId: claimedId,
      });

      // A rejection keeps the claim too.
      const revised = yield* store.saveSkill({
        claimOperationId: claim,
        files: ["SKILL.md"],
        operationId: OperationId.make("lifetime-save-three"),
        recordingId: claimedId,
        skillPath: "lifetime-flow/SKILL.md",
      });
      expect(revised.lifecycle._tag).toBe("skill-drafted");

      // The claim ends where the agent gives up, from a drafted state.
      const released = yield* store.releaseLearning({
        claimOperationId: claim,
        operationId: OperationId.make("lifetime-release"),
        recordingId: claimedId,
      });
      expect(released.lifecycle._tag).toBe("ready");
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
