import path from "node:path";

import { FlowSkillName, OperationId } from "@contingency/protocol";
import type {
  AndroidWorkspaceSelection,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Result,
} from "effect";
import type { Scope } from "effect";

import { createAndroidRun } from "../../src/services/android-run.ts";
import type {
  AndroidRuntimeBackend,
  AndroidObservation,
} from "../../src/services/android-runtime-contract.ts";
import { adaptAndroidRuntime } from "../../src/services/android-runtime.ts";
import {
  AndroidWorkspace,
  makeAndroidWorkspaceLayer,
} from "../../src/services/android-workspace.ts";
import type { AndroidWorkspaceService } from "../../src/services/android-workspace.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import { PlatformRuntimeFactory } from "../../src/services/platform-runtime.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import type { TeachingRecordingLearningService } from "../../src/services/teaching-recording-learning.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import type { TeachingRecordingStoreService } from "../../src/services/teaching-recording-store.ts";

const selection: AndroidWorkspaceSelection = {
  device: {
    api: 36,
    avd: "fixture",
    fingerprint: "fixture",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "2",
    appId: "dev.fixture",
    startingState: "Home",
  },
  helperConsent: "none",
  outcomes: [{ name: "Home", role: "text" }],
  reversibleActions: [{ name: "Edit", role: "button" }],
  setup: {
    activity: "dev.fixture/.Home",
    conditions: [{ name: "Home", role: "text" }],
    kind: "restart-activity",
  },
};
const op = OperationId.make;
const flowSkillName = FlowSkillName.make("android-edit");
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqz8AAAAASUVORK5CYII=";
const skill = `---\nname: android-edit\ndescription: Edit a public fixture field and return Home. Use when testing the Android fixture.\ninputs:\n---\n\n# Edit the fixture\n\n1. Activate the button named Edit. Done when: the public field is visible.\n2. Enter public fixture text. Done when: the field shows the value.\n3. Go back. Done when: Home is visible.\n`;

interface CaptureGate {
  readonly entered: Deferred.Deferred<boolean>;
  readonly release: Deferred.Deferred<boolean>;
}
const fixture = (
  test: (input: {
    readonly root: string;
    readonly calls: string[];
    readonly disconnect: () => void;
    readonly reconnect: () => void;
    /** Holds the next capture after it starts until the test releases it. */
    readonly holdNextCapture: () => Effect.Effect<CaptureGate>;
    /** A fresh workspace over the same root, as after a process restart. */
    readonly restart: () => Effect.Effect<
      AndroidWorkspaceService,
      never,
      Scope.Scope
    >;
  }) => Effect.Effect<
    void,
    unknown,
    | AndroidWorkspaceService
    | TeachingRecordingStoreService
    | TeachingRecordingLearningService
    | FileSystem.FileSystem
  >
) =>
  Effect.scoped(
    Effect.gen(function* workspaceFixture() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "android-workspace-test-",
      });
      const calls: string[] = [];
      let connected = true;
      let generation = 0;
      let held: CaptureGate | undefined;
      const backend: AndroidRuntimeBackend = {
        activate: () =>
          Effect.sync(() => {
            calls.push("activate");
          }),
        back: () =>
          Effect.sync(() => {
            calls.push("back");
          }),
        capture: () =>
          Effect.suspend(() => {
            const gate = held;
            held = undefined;
            return gate === undefined
              ? Effect.void
              : Deferred.succeed(gate.entered, true).pipe(
                  Effect.andThen(Deferred.await(gate.release))
                );
          }).pipe(
            Effect.map((): AndroidObservation => {
              generation += 1;
              return {
                backendSessionId: "fixture-session",
                capture: {
                  complete: true,
                  mode: "interactive-windows",
                  secureWindowVisibility: "unverified",
                  windowCount: 1,
                },
                device: selection.device,
                generation,
                id: `observation-${generation}`,
                nodes: [
                  {
                    covered: false,
                    editable: false,
                    name: "Home",
                    packageName: "dev.fixture",
                    password: false,
                    role: "text",
                    target: "@e1",
                  },
                  {
                    covered: false,
                    editable: false,
                    name: "Edit",
                    packageName: "dev.fixture",
                    password: false,
                    role: "button",
                    target: "@e2",
                  },
                ],
                ownership: {
                  focusedPackage: "dev.fixture",
                  kind: "experimental-host-check",
                  systemDialogAuthority: "unsupported",
                },
                platform: "android",
                screenshot: {
                  capturedAt: "2026-10-13T00:00:00.000Z",
                  encoding: "base64",
                  format: "png",
                  image,
                },
              };
            })
          ),
        close: () => Effect.void,
        enterPrivate: () =>
          Effect.fail(platformRuntimeError("capability_missing")),
        fill: () => Effect.void,
        recover: () => Effect.void,
        sessionId: "fixture-session",
        validate: () =>
          connected
            ? Effect.void
            : Effect.fail(platformRuntimeError("device_disconnected")),
      };
      const factory = Layer.succeed(
        PlatformRuntimeFactory,
        PlatformRuntimeFactory.of({
          android: {
            capabilities: ["semantic-actions", "screenshots"],
            createRun: (input) =>
              createAndroidRun(input, {
                preflight: () => Effect.void,
                start: (startup) => adaptAndroidRuntime({ backend, startup }),
              }),
            platform: "android",
            start: () => Effect.die("Attach-only runtime must not be used."),
          },
          start: () => Effect.die("Generic runtime must not be used."),
          web: {
            capabilities: [],
            platform: "web",
            start: () => Effect.die("Browser runtime must not be used."),
          },
        })
      );
      const store = makeTeachingRecordingStoreLayer({ root: () => root });
      const dependencies = Layer.mergeAll(
        store,
        makeFlowSkillCatalogLayer({ root }),
        factory
      );
      const workspace = makeAndroidWorkspaceLayer({ root: () => root }).pipe(
        Layer.provide(dependencies)
      );
      const learning = TeachingRecordingLearningLive.pipe(Layer.provide(store));
      const services = yield* Effect.context<FileSystem.FileSystem>();
      const restart = () =>
        Layer.build(
          makeAndroidWorkspaceLayer({ root: () => root }).pipe(
            Layer.provide(
              Layer.mergeAll(
                makeTeachingRecordingStoreLayer({ root: () => root }),
                makeFlowSkillCatalogLayer({ root }),
                factory
              )
            )
          )
        ).pipe(
          Effect.map((context) => Context.get(context, AndroidWorkspace)),
          Effect.provide(services),
          Effect.orDie
        );
      yield* test({
        calls,
        disconnect: () => {
          connected = false;
        },
        holdNextCapture: () =>
          Effect.gen(function* holdCapture() {
            const gate = {
              entered: yield* Deferred.make<boolean>(),
              release: yield* Deferred.make<boolean>(),
            };
            held = gate;
            return gate;
          }),
        reconnect: () => {
          connected = true;
        },
        restart,
        root,
      }).pipe(Effect.provide(Layer.mergeAll(workspace, store, learning)));
    })
  ).pipe(Effect.provide(NodeServices.layer));

const taught = Effect.gen(function* recordAndLearn() {
  const workspace = yield* AndroidWorkspace;
  const started = yield* workspace.execute(
    {
      _tag: "start",
      flowSkillName,
      kind: "teaching",
      operationId: op("start-teaching"),
      recordingId: null,
      selection,
    },
    "user"
  );
  expect(started.observation).toBeNull();
  yield* workspace.execute(
    {
      _tag: "prepare",
      operationId: op("prepare-teaching"),
      sessionId: started.id,
    },
    "user"
  );
  yield* workspace.execute(
    {
      _tag: "record",
      operationId: op("record-start"),
      sessionId: started.id,
      start: true,
    },
    "user"
  );
  const observed = yield* workspace.execute(
    { _tag: "observe", image: false, sessionId: started.id },
    "agent"
  );
  yield* workspace.execute(
    {
      _tag: "input",
      action: { _tag: "activate", target: "@e2" },
      observationId: observed.observation?.id ?? "",
      operationId: op("teach-input"),
      sessionId: started.id,
    },
    "user"
  );
  yield* workspace.execute(
    {
      _tag: "instruction",
      operationId: op("instruction"),
      sessionId: started.id,
      text: "Return to Home; use only public fixture text.",
    },
    "user"
  );
  const stopped = yield* workspace.execute(
    {
      _tag: "record",
      operationId: op("record-stop"),
      sessionId: started.id,
      start: false,
    },
    "user"
  );
  expect(stopped.captureState?._tag).toBe("ready");
  if (stopped.recordingId === null) {
    return yield* Effect.die("Recording missing.");
  }
  yield* workspace.execute(
    { _tag: "close", operationId: op("close-teaching"), sessionId: started.id },
    "user"
  );
  const store = yield* TeachingRecordingStore;
  yield* store.startLearning({
    operationId: op("claim"),
    recordingId: stopped.recordingId,
  });
  const learning = yield* TeachingRecordingLearning;
  const timeline = yield* learning.timeline({
    claimOperationId: op("claim"),
    cursor: 0,
    recordingId: stopped.recordingId,
  });
  expect(JSON.stringify(timeline)).toContain("Activate button Edit");
  yield* learning.save({
    claimOperationId: op("claim"),
    files: [{ content: skill, path: "SKILL.md" }],
    operationId: op("save"),
    recordingId: stopped.recordingId,
  });
  return stopped.recordingId;
});
const dryRun = (recordingId: TeachingRecordingId) =>
  Effect.gen(function* startDryRun() {
    const workspace = yield* AndroidWorkspace;
    const started = yield* workspace.execute(
      {
        _tag: "start",
        flowSkillName,
        kind: "dry-run",
        operationId: op("start-dry"),
        recordingId,
        selection,
      },
      "agent"
    );
    return yield* workspace.execute(
      {
        _tag: "prepare",
        operationId: op("prepare-dry"),
        sessionId: started.id,
      },
      "user"
    );
  });

it.effect("cancelling a mirror capture leaves Teaching intact", () =>
  fixture(({ holdNextCapture }) =>
    Effect.gen(function* cancelMirror() {
      const workspace = yield* AndroidWorkspace;
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowSkillName,
          kind: "teaching",
          operationId: op("start-teaching"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        { _tag: "prepare", operationId: op("prepare"), sessionId: started.id },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("record-start"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      const gate = yield* holdNextCapture();
      // Navigation away from the mirror interrupts its in-flight request.
      const mirror = yield* Effect.forkChild(
        workspace.execute(
          { _tag: "observe", image: true, sessionId: started.id },
          "user"
        )
      );
      yield* Deferred.await(gate.entered);
      yield* Fiber.interrupt(mirror);
      yield* Deferred.succeed(gate.release, true);
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("record-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      expect(stopped.phase).toBe("running");
      expect(stopped.captureGaps).toEqual([]);
      expect(stopped.captureState?._tag).toBe("ready");
    })
  )
);

it.effect(
  "a newer mirror frame does not consume a unique semantic selection or repeat its dispatch",
  () =>
    fixture(({ calls }) =>
      Effect.gen(function* mirrorSelection() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowSkillName,
            kind: "teaching",
            operationId: op("mirror-start"),
            recordingId: null,
            selection,
          },
          "user"
        );
        const prepared = yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("mirror-prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const mirror = yield* workspace.execute(
          { _tag: "observe", image: true, sessionId: started.id },
          "user"
        );
        expect(mirror.observation?.id).not.toBe(prepared.observation?.id);
        const action = {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: prepared.observation?.id ?? "",
          operationId: op("mirror-input"),
          sessionId: started.id,
        } as const;
        const result = yield* workspace.execute(action, "user");
        expect(result.phase).toBe("running");
        yield* workspace.execute(action, "user");
        expect(calls.filter((call) => call === "activate")).toHaveLength(1);
      })
    )
);

it.effect(
  "records forwarded semantic input, stamps Android without browser metadata, verifies and purges evidence",
  () =>
    fixture(({ restart, root }) =>
      Effect.gen(function* lifecycle() {
        const recordingId = yield* taught;
        const fs = yield* FileSystem.FileSystem;
        const packageFile = yield* fs.readFileString(
          path.join(root, "android-edit", "SKILL.md")
        );
        expect(packageFile).toContain('"platform":"android"');
        expect(packageFile).not.toContain("emulation:");
        expect(packageFile).not.toContain("hosts:");
        const prepared = yield* dryRun(recordingId);
        const workspace = yield* AndroidWorkspace;
        yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Home is visible.",
              observationId: prepared.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("complete-dry"),
            sessionId: prepared.id,
          },
          "agent"
        );
        expect(
          (yield* workspace.execute(
            { _tag: "read", sessionId: prepared.id },
            "agent"
          )).captureState?._tag
        ).toBe("dry-run-passed");
        const denied = yield* Effect.result(
          workspace.execute(
            {
              _tag: "flow-decision",
              decision: "verify",
              operationId: op("agent-verify"),
              sessionId: prepared.id,
            },
            "agent"
          )
        );
        expect(Result.isFailure(denied)).toBe(true);
        const verified = yield* workspace.execute(
          {
            _tag: "flow-decision",
            decision: "verify",
            operationId: op("user-verify"),
            sessionId: prepared.id,
          },
          "user"
        );
        expect(verified.cleanup?._tag).toBe("purged");
        expect(verified.observation).toBeNull();
        const reopened = yield* Effect.scoped(
          Effect.flatMap(restart(), (fresh) =>
            fresh.execute({ _tag: "read", sessionId: prepared.id }, "agent")
          )
        );
        expect(reopened.captureState?._tag).toBe("verified");
        expect(reopened.cleanup?._tag).toBe("purged");
        const store = yield* TeachingRecordingStore;
        expect(
          yield* fs.exists(
            path.join(store.directory(recordingId), "events.jsonl")
          )
        ).toBe(false);
        expect(
          yield* fs.exists(path.join(root, "android-edit", "SKILL.md"))
        ).toBe(true);
        const later = yield* workspace.execute(
          {
            _tag: "start",
            flowSkillName,
            kind: "run",
            operationId: op("later"),
            recordingId: null,
            selection,
          },
          "agent"
        );
        expect(later.kind).toBe("run");
      })
    )
);

it.effect(
  "Takeover disables agent dispatch and prevents a passing Dry Run after return",
  () =>
    fixture(() =>
      Effect.gen(function* takeover() {
        const recordingId = yield* taught;
        const prepared = yield* dryRun(recordingId);
        const workspace = yield* AndroidWorkspace;
        const taken = yield* workspace.execute(
          {
            _tag: "control",
            controller: "user",
            operationId: op("takeover"),
            sessionId: prepared.id,
          },
          "user"
        );
        const blocked = yield* Effect.result(
          workspace.execute(
            {
              _tag: "input",
              action: { _tag: "activate", target: "@e2" },
              observationId: taken.observation?.id ?? "",
              operationId: op("blocked-input"),
              sessionId: prepared.id,
            },
            "agent"
          )
        );
        expect(Result.isFailure(blocked)).toBe(true);
        const returned = yield* workspace.execute(
          {
            _tag: "control",
            controller: "agent",
            operationId: op("return"),
            sessionId: prepared.id,
          },
          "user"
        );
        const completed = yield* workspace.execute(
          {
            _tag: "complete",
            assessment: {
              explanation: "Home remains visible.",
              observationId: returned.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("complete"),
            sessionId: prepared.id,
          },
          "agent"
        );
        expect(completed.captureState?._tag).toBe("dry-run-failed");
        expect(completed.assessment?.outcome).toBe("inconclusive");
      })
    )
);

it.effect(
  "disconnect ends Teaching incomplete and does not replay a failed input",
  () =>
    fixture(({ disconnect, calls }) =>
      Effect.gen(function* incomplete() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowSkillName,
            kind: "teaching",
            operationId: op("start"),
            recordingId: null,
            selection,
          },
          "user"
        );
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const recording = yield* workspace.execute(
          {
            _tag: "record",
            operationId: op("record"),
            sessionId: started.id,
            start: true,
          },
          "user"
        );
        disconnect();
        const command = {
          _tag: "input",
          action: { _tag: "activate", target: "@e2" },
          observationId: recording.observation?.id ?? "",
          operationId: op("input"),
          sessionId: started.id,
        } as const;
        expect(
          Result.isFailure(
            yield* Effect.result(workspace.execute(command, "user"))
          )
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* Effect.result(workspace.execute(command, "user"))
          )
        ).toBe(true);
        expect(calls).not.toContain("activate");
        const failed = yield* workspace.execute(
          { _tag: "read", sessionId: started.id },
          "agent"
        );
        expect(failed.phase).toBe("paused");
        expect(failed.captureState?._tag).toBe("failed");
        expect(failed.captureGaps).toContain("device_disconnected");
      })
    )
);
