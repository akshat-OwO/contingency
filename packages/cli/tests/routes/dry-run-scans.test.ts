import path from "node:path";

import {
  FlowName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { makeDryRunArtifactRoutes } from "../../src/routes/agent-run-artifacts.ts";
import { AgentRunStore } from "../../src/services/agent-run-store.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import { RunVideoRenderer } from "../../src/services/run-video-renderer.ts";
import {
  dryRunDirectory,
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

it.effect(
  "serves persisted scans after session exit and rejection until the next Dry Run starts",
  () =>
    Effect.gen(function* persistedScans() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped();
      const recordingId = TeachingRecordingId.make("recording-scans");
      const summary = {
        ...taskRunSummary,
        scanReports: [
          {
            flowName: "cart",
            id: "scan-abc",
            mode: "accessibility" as const,
            reportPath: "scans/scan-abc.json",
            requirementId: "scan-cart",
            startedAt: taskRunSummary.startedAt,
            status: "completed" as const,
            summary: "No violations.",
            tabId: "tab-cart",
            url: "http://localhost/",
          },
        ],
      };
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      yield* Effect.gen(function* exercise() {
        const store = yield* TeachingRecordingStore;
        const mutation = (id: string) => ({
          recordingId,
          operationId: OperationId.make(id),
        });
        yield* store.begin({
          ...mutation("begin"),
          emulation: summary.startingEmulation,
          flowName: FlowName.make("cart"),
          sessionId: summary.sessionId,
        });
        yield* store.start({
          ...mutation("start"),
          emulation: summary.startingEmulation,
        });
        yield* store.stop({ ...mutation("stop"), artifacts: [] });
        yield* store.startLearning(mutation("learn"));
        yield* files.writeFileString(
          path.join(root, "cart", "flow.md"),
          "---\nname: cart\ndescription: Read the cart.\ninputs: []\nhosts: [localhost]\n---\nRead the cart.\n"
        );
        yield* store.saveFlow({
          ...mutation("save"),
          claimOperationId: OperationId.make("learn"),
          files: ["flow.md"],
        });
        yield* store.startDryRun({
          ...mutation("dry"),
          inputs: [],
          sessionId: summary.sessionId,
        });
        yield* store.passDryRun({
          ...mutation("pass"),
          observableOutcome: "Cart ready.",
        });
        yield* store.attachDryRunSummary({ ...mutation("summary"), summary });
        const directory = dryRunDirectory(
          store.directory(recordingId),
          summary.runId
        );
        yield* files.makeDirectory(path.join(directory, "scans"), {
          recursive: true,
        });
        yield* files.writeFileString(
          path.join(directory, "scans/scan-abc.json"),
          '{"report":"retained"}'
        );
        const origin = "http://127.0.0.1:7777";
        const handler = HttpRouter.toWebHandler(
          makeDryRunArtifactRoutes({ allowedOrigins: new Set([origin]) }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                storeLayer,
                Layer.mock(AgentRunStore, {}),
                Layer.mock(RunVideoRenderer, {}),
                Layer.mock(AgentSession, {
                  get: () =>
                    Effect.fail({
                      _tag: "BrowserRpcError",
                      code: "agent_session_not_found",
                      message: "Session exited.",
                    }),
                })
              )
            ),
            Layer.provideMerge(NodeHttpPlatform.layer),
            Layer.provideMerge(NodeServices.layer)
          ),
          { disableLogger: true }
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => handler.dispose())
        );
        const request = (report = "scan-abc") =>
          Effect.promise(() =>
            handler.handler(
              new Request(
                `${origin}/teaching-recordings/${recordingId}/dry-run/scans/${report}`,
                { headers: { host: "127.0.0.1:7777" } }
              )
            )
          );
        const assertReport = Effect.gen(function* download() {
          const response = yield* request();
          expect(response.status).toBe(200);
          expect(response.headers.get("content-disposition")).toBe(
            'attachment; filename="scan-abc.json"'
          );
          expect(yield* Effect.promise(() => response.json())).toEqual({
            report: "retained",
          });
        });
        yield* assertReport;
        expect((yield* request("scan-def")).status).toBe(404);
        expect((yield* request("scan-abc%2F..%2Fsecret")).status).toBe(404);
        yield* store.reject(mutation("reject"));
        yield* assertReport;
        yield* store.startDryRun({
          ...mutation("next"),
          inputs: [],
          sessionId: summary.sessionId,
        });
        expect((yield* request()).status).toBe(404);
        expect(
          yield* files.exists(path.join(directory, "scans/scan-abc.json"))
        ).toBe(true);
      }).pipe(Effect.provide(storeLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
