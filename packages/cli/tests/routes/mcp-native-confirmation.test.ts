import { AgentSessionId, FlowName, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";

import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";
import {
  corpusAndroidSelection,
  corpusIosSelection,
  corpusIosSimulator,
  makeCorpusAndroidWorkspaceLayer,
  makeCorpusIosWorkspaceLayer,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

// One hang guard per test, sized for a hung process rather than the work.
const HANG_GUARD_MS = 60_000;

const Execution = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      intervention: Schema.optional(
        Schema.Struct({
          operation: Schema.String,
          pending: Schema.Array(
            Schema.Struct({ id: Schema.String, kind: Schema.String })
          ),
          reasons: Schema.Array(Schema.String),
          sessionId: Schema.String,
        })
      ),
      status: Schema.String,
    }),
  }),
});

const platforms = [
  {
    button: "SHOW ALERT",
    platform: "android",
    selection: corpusAndroidSelection(),
  },
  { button: "Continue", platform: "ios", selection: corpusIosSelection() },
] as const;

it.live.each(platforms)(
  "ends a $platform program at a Confirmation with pending_decision, not device_preparation",
  ({ button, platform, selection }) =>
    Effect.gen(function* confirmationIntervention() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: `contingency-${platform}-confirmation-`,
      });
      const script = { start: "controls", transitions: [] };
      const shared = Layer.merge(
        makeFlowCatalogLayer({ root }),
        makeTeachingRecordingStoreLayer({ root: () => root })
      );
      const android = Context.get(
        yield* Layer.build(
          makeCorpusAndroidWorkspaceLayer({
            device: makeCorpusNativeBackend({
              device: corpusAndroidSelection().device,
              platform: "android",
              script,
            }),
            root: () => root,
          }).pipe(Layer.provide(shared))
        ),
        AndroidWorkspace
      );
      const ios = Context.get(
        yield* Layer.build(
          makeCorpusIosWorkspaceLayer({
            device: makeCorpusNativeBackend({
              device: corpusIosSimulator,
              platform: "ios",
              script,
            }),
            root: () => root,
          }).pipe(Layer.provide(shared))
        ),
        IosWorkspace
      );
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({
          androidWorkspace: Layer.succeed(AndroidWorkspace, android),
          catalogRoot: root,
          iosWorkspace: Layer.succeed(IosWorkspace, ios),
        })
      );
      const execute = (code: string) =>
        Effect.map(
          request("tools/call", {
            arguments: { code },
            name: "agent_code_execute",
          }),
          (body) =>
            Schema.decodeUnknownSync(Execution)(body).result.structuredContent
        );
      const workspace = (command: Schema.Json) =>
        `tools.agent_device_workspace(${JSON.stringify({ command, platform })})`;

      // A start still ends at device preparation, which only the user does.
      const started = yield* execute(
        `return await ${workspace({
          _tag: "start",
          agentSetup: true,
          flowName: FlowName.make(`${platform}-confirmation`),
          kind: "teaching",
          operationId: OperationId.make(`${platform}-start`),
          recordingId: null,
          selection,
        })};`
      );
      expect(started.status).toBe("intervention");
      expect(started.intervention?.reasons).toContain("device_preparation");
      const sessionId = AgentSessionId.make(
        started.intervention?.sessionId ?? ""
      );
      const prepare = {
        _tag: "prepare",
        operationId: OperationId.make(`${platform}-prepare`),
        sessionId,
      } as const;
      yield* platform === "android"
        ? android.execute(prepare, "user")
        : ios.execute(prepare, "user");

      // An irreversible activation opens a Confirmation, which ends the program.
      const confirmed = yield* execute(
        `const observed = await ${workspace({
          _tag: "observe",
          image: false,
          sessionId,
        })};
        const target = observed.observation.nodes.find((node) => node.name === ${JSON.stringify(button)}).target;
        await tools.agent_device_workspace({ platform: ${JSON.stringify(platform)}, command: {
          _tag: "input",
          action: { _tag: "activate", target },
          irreversible: true,
          observationId: observed.observation.id,
          operationId: "${platform}-irreversible",
          sessionId: ${JSON.stringify(sessionId)},
        } });`
      );
      expect(confirmed.status).toBe("intervention");
      expect(confirmed.intervention?.operation).toBe("agent_device_workspace");
      expect(confirmed.intervention?.sessionId).toBe(sessionId);
      expect(confirmed.intervention?.pending.map(({ kind }) => kind)).toEqual([
        "confirmation",
      ]);
      expect(confirmed.intervention?.reasons).toEqual(["pending_decision"]);
    }).pipe(
      Effect.scoped,
      Effect.timeout(HANG_GUARD_MS),
      Effect.provide(NodeServices.layer)
    ),
  HANG_GUARD_MS
);
