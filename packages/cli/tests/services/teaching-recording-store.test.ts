import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  AgentRunId,
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
  FLOW_CONTRACT_FILES,
  flowVerificationDigests,
  readFlowSkillFrontmatter,
} from "../../src/services/flow-skill-package.ts";
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

const demonstratedEmulation = {
  ...emulation,
  colorScheme: "dark" as const,
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
};

const layerFor = (root: string) =>
  makeTeachingRecordingStoreLayer({
    now: () => new Date(at),
    root: () => root,
  }).pipe(Layer.provideMerge(NodeServices.layer));

it.effect.each([
  "never",
  "before-start",
  "before-pass",
  "before-verification",
] as const)(
  "verifies a Flow without persisting input values and retries lifecycle operations safely (%s)",
  (moveAt) =>
    Effect.gen(function* retryTeachingLifecycle() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-store-",
      });
      const flowDirectory = path.join(
        root,
        ...(moveAt === "never" ? [] : ["shop"]),
        "checkout-flow"
      );
      const moveFlow = fileSystem
        .makeDirectory(path.join(root, "shop"), { recursive: true })
        .pipe(
          Effect.andThen(
            fileSystem.rename(path.join(root, "checkout-flow"), flowDirectory)
          )
        );
      const artifactDirectory = path.join(
        root,
        "checkout-flow",
        TEACHING_RECORDINGS_DIRECTORY,
        recordingId
      );
      const artifactFile = path.join(artifactDirectory, "keyframe-1.png");
      const inputValue = "verification-input-must-stay-private-622";
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
        // The user changed the Emulation during setup, after the bundle was
        // begun; Start declares the one the journey was demonstrated under.
        const start = {
          emulation: demonstratedEmulation,
          operationId: OperationId.make("start-once"),
          recordingId,
        };
        const started = yield* store.start(start);
        expect(started.emulation).toEqual(demonstratedEmulation);
        yield* store.start(start);
        const extraStart = yield* Effect.flip(
          store.start({
            emulation,
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
          files: ["flow.md"],
          operationId: OperationId.make("save-skill-once"),
          recordingId,
        });
        expect(
          drafted.receipts.find((receipt) => receipt.operation === "save-skill")
            ?.files
        ).toEqual(["flow.md"]);
        yield* fileSystem.makeDirectory(path.join(root, "checkout-flow"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(root, "checkout-flow", "flow.md"),
          "---\nname: checkout-flow\n---\n"
        );
        const otherRecordings = ["capturing", "rehearsing"].map((state) =>
          TeachingRecordingId.make(`recording-other-${state}`)
        );
        for (const id of otherRecordings) {
          yield* store.begin({
            ...begin,
            operationId: OperationId.make(`begin-${id}`),
            recordingId: id,
            sessionId: AgentSessionId.make(`agent-${id}`),
          });
          yield* store.start({
            ...start,
            operationId: OperationId.make(`start-${id}`),
            recordingId: id,
          });
          yield* fileSystem.writeFileString(
            path.join(store.directory(id), "keep.txt"),
            "other evidence"
          );
          if (id === otherRecordings[1]) {
            yield* store.stop({
              artifacts: [],
              operationId: OperationId.make(`stop-${id}`),
              recordingId: id,
            });
            yield* store.startLearning({
              operationId: OperationId.make(`learn-${id}`),
              recordingId: id,
            });
            yield* store.saveSkill({
              claimOperationId: OperationId.make(`learn-${id}`),
              files: ["flow.md"],
              operationId: OperationId.make(`save-${id}`),
              recordingId: id,
            });
            yield* store.startDryRun({
              inputs: [],
              operationId: OperationId.make(`dry-${id}`),
              recordingId: id,
              sessionId: AgentSessionId.make("agent-other-session"),
            });
            const otherRun = yield* store.prepareDryRun(
              id,
              AgentRunId.make("agentrun-other-dry-run")
            );
            yield* fileSystem.writeFileString(
              path.join(otherRun, "keep.txt"),
              "active Dry Run"
            );
          }
        }
        const document = path.join(root, "checkout-flow", "support.md");
        yield* fileSystem.writeFileString(document, "supporting document");
        const ordinaryRun = path.join(
          root,
          "checkout-flow",
          "runs",
          "ordinary-run"
        );
        yield* fileSystem.makeDirectory(ordinaryRun, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(ordinaryRun, "keep.txt"),
          "task evidence"
        );
        if (moveAt === "before-start") {
          yield* moveFlow;
        }
        yield* store.startDryRun({
          inputs: [
            { changed: true, name: "account", value: inputValue },
            { changed: false, name: "region", value: inputValue },
            { changed: false, name: "password", value: null },
          ],
          operationId: OperationId.make("dry-run-once"),
          recordingId,
          sessionId,
        });
        for (const runId of [
          "agentrun-dry-attempt-one",
          "agentrun-dry-attempt-two",
        ]) {
          const evidence = yield* store.prepareDryRun(
            recordingId,
            AgentRunId.make(runId)
          );
          expect(evidence).toBe(
            path.join(
              moveAt === "before-start"
                ? flowDirectory
                : path.join(root, "checkout-flow"),
              "runs",
              runId
            )
          );
          yield* fileSystem.writeFileString(
            path.join(evidence, "video.webm"),
            "sensitive"
          );
        }
        if (moveAt === "before-pass") {
          yield* moveFlow;
        }
        yield* store.passDryRun({
          observableOutcome: "The order is confirmed.",
          operationId: OperationId.make("dry-run-pass-once"),
          recordingId,
        });
        if (moveAt === "before-verification") {
          yield* moveFlow;
        }
        const verification = {
          operationId: OperationId.make("verification-once"),
          recordingId,
        };
        const skillFile = path.join(flowDirectory, "flow.md");
        const passingContent = yield* fileSystem.readFileString(skillFile);
        yield* fileSystem.writeFileString(
          skillFile,
          `---\nname: checkout-flow\nruntime: ${JSON.stringify({ capabilities: [], environment: { androidVersion: "16", appBuild: "42", appId: "example.app", startingState: "baseline" }, platform: "android" })}\n---\n`
        );
        const mismatched = yield* Effect.flip(
          store.verify({
            ...verification,
            operationId: OperationId.make("verification-platform-mismatch"),
          })
        );
        expect(mismatched.code).toBe("teaching_recording_conflict");
        expect(mismatched.message).toContain("platform requirements");
        yield* fileSystem.writeFileString(skillFile, passingContent);
        for (const contract of FLOW_CONTRACT_FILES) {
          yield* fileSystem.writeFileString(
            path.join(flowDirectory, contract),
            "{}\n"
          );
        }
        yield* store.verify(verification);
        yield* store.verify(verification);
        const cleanup = {
          operationId: OperationId.make("cleanup-once"),
          recordingId,
        };
        yield* store.cleanup(cleanup);
        for (const id of otherRecordings) {
          expect(
            yield* fileSystem.readFileString(
              path.join(flowDirectory, "recordings", id, "keep.txt")
            )
          ).toBe("other evidence");
        }
        expect(
          yield* fileSystem.readFileString(
            path.join(
              flowDirectory,
              "runs",
              "agentrun-other-dry-run",
              "keep.txt"
            )
          )
        ).toBe("active Dry Run");
        expect(
          yield* fileSystem.readFileString(
            path.join(flowDirectory, "runs", "ordinary-run", "keep.txt")
          )
        ).toBe("task evidence");
        expect(
          yield* fileSystem.readFileString(
            path.join(flowDirectory, "support.md")
          )
        ).toBe("supporting document");
        for (const runId of [
          "agentrun-dry-attempt-one",
          "agentrun-dry-attempt-two",
        ]) {
          expect(
            yield* fileSystem.exists(path.join(flowDirectory, "runs", runId))
          ).toBe(false);
        }
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
      const files = yield* fileSystem.readDirectory(flowDirectory, {
        recursive: true,
      });
      expect(files).toContain("flow.md");
      expect(files).not.toContain(path.join("references", "verification.md"));
      for (const file of files.filter(
        (name) => !name.startsWith("recordings/")
      )) {
        const target = path.join(flowDirectory, file);
        if ((yield* fileSystem.stat(target)).type === "File") {
          expect(yield* fileSystem.readFileString(target), file).not.toContain(
            inputValue
          );
        }
      }
      const savedContent = yield* fileSystem.readFileString(
        path.join(flowDirectory, "flow.md")
      );
      const saved = readFlowSkillFrontmatter(savedContent);
      expect(saved?.verification).toEqual({
        completedAt: at,
        digests: flowVerificationDigests(
          savedContent,
          FLOW_CONTRACT_FILES.map((name) => ({ content: "{}\n", path: name }))
        ),
        inputs: [
          { changed: true, name: "account" },
          { changed: false, name: "region" },
          { changed: false, name: "password" },
        ],
        observableOutcome: "The order is confirmed.",
        origin: "workspace",
        outcome: "passed",
        platform: "web",
        verifiedAt: at,
      });
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
          emulation,
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
        "delivery-flow",
        TEACHING_RECORDINGS_DIRECTORY,
        retainedId
      );
      const artifactFile = path.join(directory, "events.jsonl");
      const skillFile = path.join(root, "delivery-flow", "flow.md");
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
          emulation,
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
        yield* fileSystem.writeFileString(
          skillFile,
          "---\nname: delivery-flow\n---\n# Delivery flow\n"
        );
        yield* store.saveSkill({
          claimOperationId: OperationId.make("retention-learn"),
          files: ["flow.md"],
          operationId: OperationId.make("retention-save"),
          recordingId: retainedId,
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
          path.join(root, "delivery-flow", "flow.md")
        )
      ).toContain("Mumbai");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([false, true])(
  "recovers cleanup at startup (verification interrupted before a Flow move: %s)",
  (recoverVerification) =>
    Effect.gen(function* recoverPurgePending() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-purge-recovery-",
      });
      const recoveryId = TeachingRecordingId.make("recording-purge-recovery");
      const directory = path.join(
        root,
        "recovery-flow",
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
          emulation,
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
          files: ["flow.md"],
          operationId: OperationId.make("recovery-save"),
          recordingId: recoveryId,
        });
        yield* fileSystem.makeDirectory(path.join(root, "recovery-flow"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(root, "recovery-flow", "flow.md"),
          "---\nname: recovery-flow\n---\n"
        );
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
        const manifestFile = path.join(directory, "manifest.json");
        const passedManifest = yield* fileSystem.readFileString(manifestFile);
        const pending = yield* store.verify({
          operationId: OperationId.make("recovery-verify"),
          recordingId: recoveryId,
        });
        expect(pending.cleanup._tag).toBe("purge-pending");
        if (recoverVerification) {
          // Simulate exit after stamping flow.md but before committing verification.
          yield* fileSystem.writeFileString(manifestFile, passedManifest);
          yield* fileSystem.makeDirectory(path.join(root, "shop"));
          yield* fileSystem.rename(
            path.join(root, "recovery-flow"),
            path.join(root, "shop", "recovery-flow")
          );
        }
      }).pipe(Effect.provide(layerFor(root)));

      yield* Effect.gen(function* startRecoveredStore() {
        yield* TeachingRecordingStore;
      }).pipe(Effect.provide(layerFor(root)));

      expect(yield* fileSystem.exists(directory)).toBe(false);
      expect(yield* fileSystem.exists(artifactFile)).toBe(false);

      // A later process still reads the outcome after the directory is gone.
      const reopened = yield* Effect.gen(function* readPurgedRecording() {
        const store = yield* TeachingRecordingStore;
        return yield* store.read(recoveryId);
      }).pipe(Effect.provide(layerFor(root)));
      expect(reopened.lifecycle._tag).toBe("verified");
      expect(reopened.cleanup._tag).toBe("purged");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("keeps a verified Flow Skill retryable when cleanup fails", () =>
  Effect.gen(function* exposeCleanupFailure() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-cleanup-failure-",
    });
    const failureId = TeachingRecordingId.make("recording-cleanup-failure");
    const directory = path.join(
      root,
      "cleanup-failure-flow",
      TEACHING_RECORDINGS_DIRECTORY,
      failureId
    );
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
        emulation,
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

it.live(
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
      const children = yield* Effect.acquireRelease(
        Effect.sync(() =>
          ["claim-one", "claim-two"].map((operation) =>
            spawn(
              process.execPath,
              [
                "--experimental-strip-types",
                helper,
                "claim",
                root,
                operation,
                "barrier",
              ],
              { cwd, stdio: ["pipe", "pipe", "pipe"] }
            )
          )
        ),
        (peers) =>
          Effect.sync(() => {
            for (const peer of peers) {
              peer.kill();
            }
          })
      );
      const outputs = yield* Effect.callback<readonly string[], Error>(
        (resume) => {
          const stdout = ["", ""];
          const stderr = ["", ""];
          const attempted = new Set<number>();
          const closed = new Set<number>();
          const cleanup: (() => void)[] = [];
          for (const [index, child] of children.entries()) {
            const onStdout = (chunk: Buffer) => {
              stdout[index] += chunk.toString();
              if (
                !attempted.has(index) &&
                stdout[index]?.startsWith("attempted\n")
              ) {
                attempted.add(index);
                if (attempted.size === children.length) {
                  for (const peer of children) {
                    peer.stdin.end();
                  }
                }
              }
            };
            const onStderr = (chunk: Buffer) => {
              stderr[index] += chunk.toString();
            };
            const onError = (cause: Error) => resume(Effect.fail(cause));
            const onClose = (
              code: number | null,
              signal: NodeJS.Signals | null
            ) => {
              if (code !== 0) {
                resume(
                  Effect.fail(
                    new Error(
                      `Claim process exited (${code ?? signal}): ${stderr[index]}`
                    )
                  )
                );
                return;
              }
              closed.add(index);
              if (closed.size === children.length) {
                resume(Effect.succeed(stdout));
              }
            };
            child.stdout.on("data", onStdout);
            child.stderr.on("data", onStderr);
            child.once("error", onError);
            child.once("close", onClose);
            cleanup.push(() => {
              child.stdout.off("data", onStdout);
              child.stderr.off("data", onStderr);
              child.off("error", onError);
              child.off("close", onClose);
            });
          }
          return Effect.sync(() => {
            for (const removeListeners of cleanup) {
              removeListeners();
            }
          });
        }
      ).pipe(Effect.timeout("10 seconds"));
      const outcomes = outputs.map((output) =>
        JSON.parse(output.slice("attempted\n".length))
      );
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
          emulation,
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
        emulation,
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
        "checkout-flow",
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
      "second-name",
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
        emulation,
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
    const skillFile = path.join(root, "lifetime-flow", "flow.md");
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
        emulation,
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
          files: ["flow.md"],
          operationId: OperationId.make("lifetime-save-unclaimed"),
          recordingId: claimedId,
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
        files: ["flow.md"],
        operationId: OperationId.make("lifetime-save-one"),
        recordingId: claimedId,
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
        files: ["flow.md"],
        operationId: OperationId.make("lifetime-save-two"),
        recordingId: claimedId,
      });
      expect(fixed.lifecycle._tag).toBe("skill-drafted");

      // Another live operation's claim id is a conflict, not a missing claim.
      const other = yield* Effect.result(
        store.saveSkill({
          claimOperationId: OperationId.make("lifetime-other-claim"),
          files: ["flow.md"],
          operationId: OperationId.make("lifetime-save-other"),
          recordingId: claimedId,
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

      // A Dry Run in flight reports on the package it started with.
      const midRun = yield* Effect.result(
        store.saveSkill({
          claimOperationId: claim,
          files: ["flow.md"],
          operationId: OperationId.make("lifetime-save-mid-run"),
          recordingId: claimedId,
        })
      );
      expect(midRun).toMatchObject({
        failure: { code: "teaching_recording_conflict" },
      });

      yield* store.passDryRun({
        observableOutcome: "The confirmation page appeared.",
        operationId: OperationId.make("lifetime-pass"),
        recordingId: claimedId,
      });
      // A passing Dry Run is the user's choice to make, so the claim alone
      // does not let the agent replace the package it passed with.
      const afterPass = yield* Effect.result(
        store.saveSkill({
          claimOperationId: claim,
          files: ["flow.md"],
          operationId: OperationId.make("lifetime-save-after-pass"),
          recordingId: claimedId,
        })
      );
      expect(afterPass).toMatchObject({
        failure: { code: "teaching_recording_conflict" },
      });
      if (afterPass._tag === "Failure") {
        expect(afterPass.failure.message).toContain("agent_flow_skill_decide");
      }
      expect((yield* store.read(claimedId)).lifecycle._tag).toBe(
        "dry-run-passed"
      );

      yield* store.reject({
        operationId: OperationId.make("lifetime-reject"),
        recordingId: claimedId,
      });

      // A rejection keeps the claim too.
      const revised = yield* store.saveSkill({
        claimOperationId: claim,
        files: ["flow.md"],
        operationId: OperationId.make("lifetime-save-three"),
        recordingId: claimedId,
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

it.effect.each(["", "shop/checkout"])(
  "files a draft in Group %s and recovers it after regrouping",
  (group) =>
    Effect.gen(function* regroupDraft() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-recording-group-",
      });
      const name = FlowSkillName.make("grouped-flow");
      yield* Effect.gen(function* firstProcess() {
        const store = yield* TeachingRecordingStore;
        yield* store.begin({
          emulation,
          flowSkillName: name,
          group,
          operationId: OperationId.make("group-begin"),
          recordingId,
          sessionId,
        });
        yield* store.start({
          emulation,
          operationId: OperationId.make("group-start"),
          recordingId,
        });
        expect(store.directory(recordingId)).toBe(
          path.join(root, group, name, "recordings", recordingId)
        );
        yield* fs.makeDirectory(path.join(root, "moved"));
        yield* fs.rename(
          path.join(root, group, name),
          path.join(root, "moved", name)
        );
        yield* store.stop({
          artifacts: [],
          operationId: OperationId.make("group-stop"),
          recordingId,
        });
        expect((yield* store.read(recordingId)).lifecycle._tag).toBe("ready");
      }).pipe(Effect.provide(layerFor(root)));
      yield* Effect.gen(function* secondProcess() {
        const store = yield* TeachingRecordingStore;
        expect(
          (yield* store.listReady()).map((manifest) => manifest.recordingId)
        ).toEqual([recordingId]);
        expect(store.directory(recordingId)).toBe(
          path.join(root, "moved", name, "recordings", recordingId)
        );
      }).pipe(Effect.provide(layerFor(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each(["runs", "recordings", "flow.md"])(
  "refuses reserved Flow name %s",
  (name) =>
    Effect.gen(function* refuseReserved() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-recording-name-",
      });
      yield* Effect.gen(function* attempt() {
        const store = yield* TeachingRecordingStore;
        const result = yield* Effect.flip(
          store.begin({
            emulation,
            flowSkillName: FlowSkillName.make(name),
            group: "",
            operationId: OperationId.make("reserved-begin"),
            recordingId,
            sessionId,
          })
        );
        expect(result.code).toBe("teaching_recording_invalid");
        expect(yield* fs.exists(path.join(root, name))).toBe(false);
      }).pipe(Effect.provide(layerFor(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("refuses duplicate names and Groups inside draft Flows", () =>
  Effect.gen(function* refuseCollisions() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-recording-collision-",
    });
    yield* Effect.gen(function* attempt() {
      const store = yield* TeachingRecordingStore;
      const input = {
        emulation,
        flowSkillName: FlowSkillName.make("checkout"),
        group: "shop",
        operationId: OperationId.make("collision-begin"),
        recordingId,
        sessionId,
      };
      yield* store.begin(input);
      for (const rejected of [
        { ...input, group: "other" },
        {
          ...input,
          flowSkillName: FlowSkillName.make("another"),
          group: "shop/checkout/nested",
        },
      ]) {
        const result = yield* Effect.flip(
          store.begin({
            ...rejected,
            recordingId: TeachingRecordingId.make("recording-collision"),
          })
        );
        expect(result.code).toBe("teaching_recording_invalid");
      }
      expect(yield* fs.exists(path.join(root, "other"))).toBe(false);
      expect(
        yield* fs.exists(path.join(root, "shop", "checkout", "nested"))
      ).toBe(false);
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
