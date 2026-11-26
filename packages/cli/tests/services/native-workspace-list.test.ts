import { FlowName, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";
import {
  ANDROID_WIDGET_APP,
  ANDROID_WIDGET_SCRIPT,
  IOS_WIDGET_APP,
  IOS_WIDGET_SCRIPT,
  corpusAndroidSelection,
  corpusIosSelection,
  corpusIosSimulator,
  makeCorpusAndroidWorkspaceLayer,
  makeCorpusIosWorkspaceLayer,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";

const op = OperationId.make;

/** A Catalog Root with the stores a native Workspace layer needs. */
const withStores = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* withCatalogRoot() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-native-list-",
    });
    return yield* body(root).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeTeachingRecordingStoreLayer({ root: () => root }),
          makeFlowCatalogLayer({ root })
        )
      )
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// agent_code_execute reads list() before a device command to learn which
// waits the agent has already met (mcp-code-interpreter androidIntervention).

it.effect(
  "Android list() carries an agent's pending Confirmation in preparation.pending until it is decided",
  () =>
    withStores((root) => {
      const selection = corpusAndroidSelection();
      const device = makeCorpusNativeBackend({
        device: selection.device,
        platform: "android",
        script: ANDROID_WIDGET_SCRIPT,
      });
      return Effect.gen(function* androidListedConfirmation() {
        const workspace = yield* AndroidWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            agentSetup: true,
            flowName: FlowName.make("android-list"),
            kind: "teaching",
            operationId: op("start"),
            recordingId: null,
            selection,
          },
          "agent"
        );
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const listed = Effect.map(
          workspace.list(),
          (sessions) =>
            sessions.find(({ id }) => id === started.id)?.preparation.pending
        );
        expect(yield* listed).toEqual([]);
        const shown = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: started.id },
          "agent"
        );
        const showAlert = shown.observation?.nodes.find(
          (node) => node.role === "button" && node.name === "SHOW ALERT"
        );
        if (shown.observation === null || showAlert === undefined) {
          return yield* Effect.die("SHOW ALERT must be observed");
        }
        const paused = yield* workspace.execute(
          {
            _tag: "input",
            action: { _tag: "activate", target: showAlert.target },
            irreversible: true,
            observationId: shown.observation.id,
            operationId: op("irreversible"),
            sessionId: started.id,
          },
          "agent"
        );
        const decisionId = paused.pendingDecision?.pendingDecisionId ?? "";
        expect(paused.boundary?.reason).toBe("confirmation");
        expect(yield* listed).toEqual([
          {
            id: decisionId,
            kind: "confirmation",
            targetApp: ANDROID_WIDGET_APP,
          },
        ]);
        expect(yield* listed).toEqual(paused.preparation.pending);
        yield* workspace.execute(
          {
            _tag: "decide",
            allow: false,
            decisionId,
            operationId: op("refuse"),
            sessionId: started.id,
          },
          "user"
        );
        expect(yield* listed).toEqual([]);
      }).pipe(
        Effect.provide(
          makeCorpusAndroidWorkspaceLayer({ device, root: () => root })
        )
      );
    })
);

it.effect(
  "iOS list() carries an agent's pending Confirmation in preparation.pending until it is decided",
  () =>
    withStores((root) => {
      const selection = corpusIosSelection();
      const device = makeCorpusNativeBackend({
        device: corpusIosSimulator,
        platform: "ios",
        script: IOS_WIDGET_SCRIPT,
      });
      return Effect.gen(function* iosListedConfirmation() {
        const workspace = yield* IosWorkspace;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            agentSetup: true,
            flowName: FlowName.make("ios-list"),
            kind: "teaching",
            operationId: op("start"),
            recordingId: null,
            selection,
          },
          "agent"
        );
        yield* workspace.execute(
          {
            _tag: "prepare",
            operationId: op("prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const listed = Effect.map(
          workspace.list(),
          (sessions) =>
            sessions.find(({ id }) => id === started.id)?.preparation.pending
        );
        expect(yield* listed).toEqual([]);
        const shown = yield* workspace.execute(
          { _tag: "observe", image: false, sessionId: started.id },
          "agent"
        );
        const showAlert = shown.observation?.nodes.find(
          (node) => node.role === "button" && node.name === "Show alert"
        );
        if (shown.observation === null || showAlert === undefined) {
          return yield* Effect.die("Show alert must be observed");
        }
        const paused = yield* workspace.execute(
          {
            _tag: "input",
            action: { _tag: "activate", target: showAlert.target },
            irreversible: true,
            observationId: shown.observation.id,
            operationId: op("irreversible"),
            sessionId: started.id,
          },
          "agent"
        );
        const decisionId = paused.pendingDecision?.pendingDecisionId ?? "";
        expect(paused.boundary?.reason).toBe("confirmation");
        expect(yield* listed).toEqual([
          { id: decisionId, kind: "confirmation", targetApp: IOS_WIDGET_APP },
        ]);
        expect(yield* listed).toEqual(paused.preparation.pending);
        yield* workspace.execute(
          {
            _tag: "decide",
            allow: false,
            decisionId,
            operationId: op("refuse"),
            sessionId: started.id,
          },
          "user"
        );
        expect(yield* listed).toEqual([]);
      }).pipe(
        Effect.provide(
          makeCorpusIosWorkspaceLayer({ device, root: () => root })
        )
      );
    })
);
