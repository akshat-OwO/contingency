import path from "node:path";

import {
  AgentSessionId,
  AgentSessionSnapshot,
  ContentHash,
  FlowSkillName,
  OperationId,
  TaskAgentRunState,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Schema } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import type { AgentSessionStartInput } from "../../src/services/agent-session.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import {
  decideFlowSkill,
  startDryRun,
  stopDryRun,
  teachingRecordingSummary,
} from "../../src/services/teaching-recording-orchestration.ts";
import type { DryRunStartInput } from "../../src/services/teaching-recording-orchestration.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const operation = OperationId.make;
const at = "2026-10-03T10:00:00.000Z";
const sessionId = AgentSessionId.make("agent-orchestration-test");
const flowSkillName = FlowSkillName.make("cart");
const emulation = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("default"),
  viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
};

const storeLayer = (root: string) =>
  makeTeachingRecordingStoreLayer({
    now: () => new Date(at),
    root: () => root,
  }).pipe(Layer.provideMerge(NodeServices.layer));

/** Write a saved package, verified by the user when `verified` is set. */
const writeSkill = (
  root: string,
  name: string,
  inputs: readonly string[],
  verified: boolean
) =>
  Effect.gen(function* writeFlowSkill() {
    const files = yield* FileSystem.FileSystem;
    yield* files.makeDirectory(path.join(root, name, "references"), {
      recursive: true,
    });
    const placeholders = inputs.map((input) => `{{${input}}}`).join(" and ");
    yield* files.writeFileString(
      path.join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Prepare ${name}.\ninputs:\n${inputs
        .map((input) => `  - ${input}\n`)
        .join(
          ""
        )}hosts:\n  - localhost\n---\n\n1. Use ${placeholders}. Done when: ${name} is ready.\n`
    );
    yield* files.writeFileString(
      path.join(root, name, "references/notes.txt"),
      "Shelf notes."
    );
    // Bytes that are not UTF-8 text are not part of the package an agent reads.
    yield* files.writeFile(
      path.join(root, name, "references/shelf.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])
    );
    if (verified) {
      yield* files.writeFileString(
        path.join(root, name, "references/verification.md"),
        "- Verified: 2026-10-02T00:00:00.000Z\n"
      );
    }
  });

/** A recording whose `cart` Flow Skill is saved and ready for a Dry Run. */
const draftedRecording = (root: string, recordingId: TeachingRecordingId) =>
  Effect.gen(function* draftRecording() {
    const files = yield* FileSystem.FileSystem;
    const store = yield* TeachingRecordingStore;
    const step = (name: string) => operation(`${recordingId}-${name}`);
    yield* store.begin({
      emulation,
      flowSkillName,
      operationId: step("begin"),
      recordingId,
      sessionId,
    });
    yield* store.start({ operationId: step("start"), recordingId });
    yield* files.writeFileString(
      path.join(store.directory(recordingId), "recording.webm"),
      "video"
    );
    yield* store.stop({
      artifacts: [
        {
          capturedAt: at,
          hash: ContentHash.make(
            "sha256-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          ),
          id: "video",
          kind: "video",
          path: "recording.webm",
        },
      ],
      operationId: step("stop"),
      recordingId,
    });
    yield* store.startLearning({ operationId: step("learn"), recordingId });
    yield* writeSkill(root, flowSkillName, ["sku", "PASSWORD"], false);
    yield* store.saveSkill({
      claimOperationId: step("learn"),
      files: ["SKILL.md"],
      operationId: step("save"),
      recordingId,
      skillPath: `${flowSkillName}/SKILL.md`,
    });
  });

/** Drive a recording to a passing Dry Run without a browser. */
const passedRecording = (root: string, recordingId: TeachingRecordingId) =>
  Effect.gen(function* passRecording() {
    const store = yield* TeachingRecordingStore;
    yield* draftedRecording(root, recordingId);
    yield* store.startDryRun({
      inputs: [],
      operationId: operation(`${recordingId}-dry`),
      recordingId,
      sessionId,
    });
    yield* store.passDryRun({
      observableOutcome: "The cart holds one anvil.",
      operationId: operation(`${recordingId}-pass`),
      recordingId,
    });
  });

const snapshotFor = (input: AgentSessionStartInput) =>
  Schema.decodeUnknownSync(AgentSessionSnapshot)({
    activity: "run",
    boundary: null,
    captureState: null,
    clientName: "flow-skill-dry-run",
    clientVersion: "1",
    controller: "agent",
    createdAt: at,
    currentUrl: input.url,
    dryRun: null,
    flowSkillName: null,
    id: sessionId,
    interruptedAction: null,
    ownerProcessId: "orchestration-test",
    phase: "running",
    recordingId: null,
    run: input.run ?? null,
    takeover: null,
    teaching: null,
    timeline: [],
    updatedAt: at,
    viewUrl: "http://localhost/",
  });

/**
 * An Agent Session that keeps the start ledger's contract: a replayed
 * operation id answers with the first session, and a changed request under the
 * same id conflicts.
 */
const recordingSessions = () => {
  const started = new Map<
    string,
    { readonly input: AgentSessionStartInput; readonly request: string }
  >();
  const layer = Layer.mock(AgentSession, {
    close: () => Effect.die("A started Dry Run must not close its session."),
    completeRun: () => Effect.die("Unused."),
    // The session lives in this process, but a refresh miss is ignored.
    get: () =>
      Effect.fail({
        _tag: "BrowserRpcError" as const,
        code: "agent_session_not_found" as const,
        message: "Not published here.",
      }),
    startPrepared: (request, prepare) =>
      Effect.gen(function* startPrepared() {
        const previous = started.get(request.operationId);
        if (previous !== undefined) {
          if (previous.request !== request.request) {
            return yield* Effect.fail({
              _tag: "BrowserRpcError" as const,
              code: "agent_session_conflict" as const,
              message: `Operation ${request.operationId} was already used for a different session request.`,
            });
          }
          return snapshotFor(previous.input);
        }
        const input = yield* prepare;
        started.set(request.operationId, { input, request: request.request });
        return snapshotFor(input);
      }),
  });
  return { layer, started };
};

const dryRunLayer = (
  root: string,
  sessions: ReturnType<typeof recordingSessions>
) =>
  Layer.mergeAll(
    sessions.layer,
    makeFlowSkillCatalogLayer({ root }).pipe(Layer.provide(NodeServices.layer)),
    storeLayer(root)
  );

const startInput = (
  recordingId: TeachingRecordingId,
  changes: Partial<DryRunStartInput> = {}
): DryRunStartInput => ({
  inputs: [
    { changed: true, name: "sku", secret: false, value: "anvil" },
    { changed: false, name: "PASSWORD", secret: true },
  ],
  operationId: operation("dry-run-start"),
  prerequisiteInputs: [
    {
      flowSkillName: FlowSkillName.make("location"),
      name: "area",
      value: "North",
    },
    {
      flowSkillName: FlowSkillName.make("login"),
      name: "area",
      value: "South",
    },
  ],
  prerequisites: [FlowSkillName.make("location"), FlowSkillName.make("login")],
  recordingId,
  url: "http://localhost/cart.html",
  ...changes,
});

it.effect(
  "fixes prerequisites and skill-scoped inputs at startup and conflicts on a changed replay",
  () =>
    Effect.gen(function* startWithPrerequisites() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-orchestration-start-",
      });
      const recordingId = TeachingRecordingId.make("recording-start");
      const sessions = recordingSessions();
      yield* Effect.gen(function* exercise() {
        yield* draftedRecording(root, recordingId);
        yield* writeSkill(root, "location", ["area"], true);
        yield* writeSkill(root, "login", ["area", "PASSWORD"], true);
        yield* writeSkill(root, "unverified", ["area"], false);

        const refusals: readonly [string, Partial<DryRunStartInput>][] = [
          ["unverified", { prerequisites: [FlowSkillName.make("unverified")] }],
          [
            "duplicate",
            {
              prerequisites: [
                FlowSkillName.make("login"),
                FlowSkillName.make("login"),
              ],
            },
          ],
          ["tested skill", { prerequisites: [flowSkillName] }],
          [
            "unsupplied prerequisite input",
            {
              prerequisiteInputs:
                startInput(recordingId).prerequisiteInputs.slice(1),
            },
          ],
          [
            "private prerequisite input",
            {
              prerequisiteInputs: [
                ...startInput(recordingId).prerequisiteInputs,
                {
                  flowSkillName: FlowSkillName.make("login"),
                  name: "PASSWORD",
                  value: "hunter2",
                },
              ],
            },
          ],
          [
            "incomplete inputs",
            { inputs: startInput(recordingId).inputs.slice(0, 1) },
          ],
          [
            "duplicate inputs",
            {
              inputs: [
                ...startInput(recordingId).inputs,
                { changed: false, name: "sku", secret: false, value: "mug" },
              ],
            },
          ],
          ["outside Teaching hosts", { url: "https://example.com/" }],
        ];
        for (const [label, changes] of refusals) {
          const refused = yield* Effect.flip(
            startDryRun(
              startInput(recordingId, {
                ...changes,
                operationId: operation(`refused-${label}`),
              })
            )
          );
          expect(refused.code, label).toBe(
            label === "unverified" || label === "private prerequisite input"
              ? "flow_skill_invalid"
              : "teaching_recording_invalid"
          );
        }
        expect(sessions.started.size).toBe(0);

        const started = yield* startDryRun(startInput(recordingId));
        expect(started.manifest.lifecycle._tag).toBe("dry-running");
        expect(started.skillPath).toBe("cart/SKILL.md");
        // The package is read through the catalog, text references included.
        expect(started.files.map((file) => file.path)).toEqual([
          "SKILL.md",
          "references/notes.txt",
        ]);
        expect(
          started.prerequisites.map((skill) => skill.flowSkillName)
        ).toEqual(["location", "login"]);

        const [first] = [...sessions.started.values()];
        const run = Schema.decodeUnknownSync(TaskAgentRunState)(
          first?.input.run
        );
        // Inputs keep the skill that declared them, and a secret never leaves
        // the request as a literal.
        expect(run.inputs).toEqual([
          { flowSkillName: "location", name: "area", value: "North" },
          { flowSkillName: "login", name: "area", value: "South" },
          { flowSkillName: "cart", name: "sku", value: "anvil" },
        ]);
        expect(run.variables).toEqual([
          {
            flowSkillName: "login",
            name: "PASSWORD",
            runtime: true,
            secret: true,
            supplied: false,
          },
          {
            flowSkillName: "cart",
            name: "PASSWORD",
            runtime: true,
            secret: true,
            supplied: false,
          },
        ]);
        expect(first?.input.domainScope).toEqual({ hosts: ["localhost"] });

        // A replay with the same request answers with the same Dry Run.
        const replayed = yield* startDryRun(startInput(recordingId));
        expect(replayed.session.id).toBe(started.session.id);
        expect(replayed.manifest.lifecycle._tag).toBe("dry-running");

        // Prerequisites and their inputs are fixed at startup.
        for (const changes of [
          {
            prerequisiteInputs:
              startInput(recordingId).prerequisiteInputs.slice(1),
            prerequisites: [FlowSkillName.make("login")],
          },
          {
            prerequisiteInputs: [
              {
                flowSkillName: FlowSkillName.make("location"),
                name: "area",
                value: "East",
              },
              {
                flowSkillName: FlowSkillName.make("login"),
                name: "area",
                value: "South",
              },
            ],
          },
        ] satisfies Partial<DryRunStartInput>[]) {
          const changed = yield* Effect.flip(
            startDryRun(startInput(recordingId, changes))
          );
          expect(changed.code).toBe("agent_session_conflict");
        }
      }).pipe(Effect.provide(dryRunLayer(root, sessions)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("verification wins a race with Stop after a pass", () =>
  Effect.gen(function* raceVerifyAndStop() {
    const files = yield* FileSystem.FileSystem;
    const root = yield* files.makeTempDirectoryScoped({
      prefix: "contingency-orchestration-race-",
    });
    const passedId = TeachingRecordingId.make("recording-race-passed");
    const runningId = TeachingRecordingId.make("recording-race-running");
    yield* Effect.gen(function* exercise() {
      const store = yield* TeachingRecordingStore;
      yield* passedRecording(root, passedId);
      const [verified, stopped] = yield* Effect.all(
        [
          Effect.exit(
            decideFlowSkill({
              decision: "verify",
              operationId: operation("race-verify"),
              recordingId: passedId,
            })
          ),
          Effect.exit(
            stopDryRun({
              operationId: operation("race-stop"),
              recordingId: passedId,
            })
          ),
        ],
        { concurrency: "unbounded" }
      );
      expect(Exit.isSuccess(verified)).toBe(true);
      expect(Exit.isFailure(stopped)).toBe(true);
      expect(yield* files.exists(store.directory(passedId))).toBe(false);

      // While the Dry Run is still running, Stop lands and verify conflicts.
      yield* draftedRecording(root, runningId);
      yield* store.startDryRun({
        inputs: [],
        operationId: operation("running-dry"),
        recordingId: runningId,
        sessionId,
      });
      const stoppedRun = yield* stopDryRun({
        operationId: operation("running-stop"),
        recordingId: runningId,
      });
      expect(stoppedRun.lifecycle._tag).toBe("dry-run-failed");
      const refused = yield* Effect.flip(
        decideFlowSkill({
          decision: "verify",
          operationId: operation("running-verify"),
          recordingId: runningId,
        })
      );
      expect(refused.code).toBe("teaching_recording_conflict");
      expect(teachingRecordingSummary(yield* store.read(runningId))).toEqual(
        expect.objectContaining({
          failure: "The user stopped the Dry Run before it completed.",
          lifecycle: "dry-run-failed",
        })
      );
    }).pipe(Effect.provide(storeLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "keeps verification durable through a failed Cleanup, a retry, and a restart",
  () =>
    Effect.gen(function* retryCleanup() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-orchestration-cleanup-",
      });
      const retriedId = TeachingRecordingId.make("recording-cleanup-retry");
      const restartedId = TeachingRecordingId.make("recording-cleanup-restart");
      const directory = (recordingId: TeachingRecordingId) =>
        path.join(root, TEACHING_RECORDINGS_DIRECTORY, recordingId);
      const lockedFor = (recordingId: TeachingRecordingId) =>
        path.join(directory(recordingId), "locked");
      const lock = (recordingId: TeachingRecordingId) =>
        Effect.gen(function* lockArtifacts() {
          yield* files.makeDirectory(lockedFor(recordingId));
          yield* files.writeFileString(
            path.join(lockedFor(recordingId), "trace.zip"),
            "trace"
          );
          yield* files.chmod(lockedFor(recordingId), 0);
        });
      const unlock = (recordingId: TeachingRecordingId) =>
        files.chmod(lockedFor(recordingId), 0o700).pipe(Effect.ignore);

      yield* Effect.gen(function* exercise() {
        const store = yield* TeachingRecordingStore;
        yield* passedRecording(root, retriedId);
        yield* lock(retriedId);
        const failed = yield* decideFlowSkill({
          decision: "verify",
          operationId: operation("cleanup-verify"),
          recordingId: retriedId,
        });
        // Cleanup failed, but verification stands.
        expect(failed.lifecycle._tag).toBe("verified");
        expect(failed.cleanup).toMatchObject({
          _tag: "purge-pending",
          retainedFiles: expect.arrayContaining(["locked"]),
        });
        expect(failed.cleanup).not.toMatchObject({ failure: null });
        const verification = yield* files.readFileString(
          path.join(root, "cart/references/verification.md")
        );
        expect(verification).toMatch(/^- Verified: /mu);

        const stillLocked = yield* decideFlowSkill({
          decision: "retry-cleanup",
          operationId: operation("cleanup-retry-locked"),
          recordingId: retriedId,
        });
        expect(stillLocked.lifecycle._tag).toBe("verified");
        expect(stillLocked.cleanup._tag).toBe("purge-pending");

        yield* unlock(retriedId);
        const retried = yield* decideFlowSkill({
          decision: "retry-cleanup",
          operationId: operation("cleanup-retry"),
          recordingId: retriedId,
        });
        expect(retried.cleanup._tag).toBe("purged");
        expect(yield* files.exists(directory(retriedId))).toBe(false);
        // A replayed retry answers with the purged recording.
        const replayed = yield* decideFlowSkill({
          decision: "retry-cleanup",
          operationId: operation("cleanup-retry"),
          recordingId: retriedId,
        });
        expect(replayed.cleanup._tag).toBe("purged");

        yield* files.remove(path.join(root, "cart"), { recursive: true });
        yield* passedRecording(root, restartedId);
        yield* lock(restartedId);
        const pending = yield* decideFlowSkill({
          decision: "verify",
          operationId: operation("restart-verify"),
          recordingId: restartedId,
        });
        expect(pending.cleanup._tag).toBe("purge-pending");
        expect(store.directory(restartedId)).toBe(directory(restartedId));
      }).pipe(
        Effect.provide(storeLayer(root)),
        Effect.ensuring(unlock(retriedId))
      );

      // A new process resumes the purge once the files can be deleted.
      yield* unlock(restartedId);
      yield* TeachingRecordingStore.pipe(Effect.provide(storeLayer(root)));
      expect(yield* files.exists(directory(restartedId))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("projects one summary for every learning state", () =>
  Effect.gen(function* projectSummary() {
    const files = yield* FileSystem.FileSystem;
    const root = yield* files.makeTempDirectoryScoped({
      prefix: "contingency-orchestration-summary-",
    });
    const recordingId = TeachingRecordingId.make("recording-summary");
    yield* Effect.gen(function* exercise() {
      const store = yield* TeachingRecordingStore;
      const setup = yield* store.begin({
        emulation,
        flowSkillName,
        operationId: operation("summary-begin"),
        recordingId,
        sessionId,
      });
      expect(teachingRecordingSummary(setup)).toBeUndefined();
      yield* passedRecording(
        root,
        TeachingRecordingId.make("recording-summary-passed")
      );
      const passed = yield* store.read(
        TeachingRecordingId.make("recording-summary-passed")
      );
      expect(teachingRecordingSummary(passed)).toEqual({
        cleanup: passed.cleanup,
        failure: null,
        flowSkillName,
        lifecycle: "dry-run-passed",
        recordingId: passed.recordingId,
        updatedAt: passed.updatedAt,
      });
    }).pipe(Effect.provide(storeLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
