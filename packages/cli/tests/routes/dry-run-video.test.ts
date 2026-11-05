import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dryRunVideoPath, TeachingRecordingId } from "@contingency/protocol";
import type {
  RunVideoStatus,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { makeDryRunArtifactRoutes } from "../../src/routes/agent-run-artifacts.ts";
import { AgentRunStore } from "../../src/services/agent-run-store.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import { RunVideoRenderer } from "../../src/services/run-video-renderer.ts";
import { TeachingRecordingStore } from "../../src/services/teaching-recording-store.ts";

const recordingId = TeachingRecordingId.make("recording-dry");
const runId = "agentrun-dry-video";

it.effect(
  "serves a Dry Run's video from the Run folder in its Flow's runs",
  () =>
    Effect.gen(function* dryRunVideo() {
      const flow = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "dry-run-video-"))),
        (owned) =>
          Effect.promise(() => rm(owned, { force: true, recursive: true }))
      );
      const run = path.join(flow, "runs", runId);
      yield* Effect.promise(async () => {
        await mkdir(path.join(flow, "recordings", recordingId), {
          recursive: true,
        });
        await mkdir(run, { recursive: true });
        await writeFile(path.join(run, "legacy.webm"), "webm");
      });
      const origin = "http://127.0.0.1:7777";
      const asked: string[] = [];
      const manifest = (videoPath: string): TeachingRecordingManifest =>
        // SAFETY: the routes read only the lifecycle's tag and its Dry Run
        // Summary's runId and videoPath; no other field is touched.
        ({
          lifecycle: {
            _tag: "dry-run-passed",
            dryRunSummary: { runId, videoPath },
          },
        }) as TeachingRecordingManifest;
      const serve = (videoPath: string) =>
        HttpRouter.toWebHandler(
          makeDryRunArtifactRoutes({ allowedOrigins: new Set([origin]) }).pipe(
            // Routes read these per request, from the served context.
            Layer.provideMerge(
              Layer.mergeAll(
                // The scan route shares this layer; these requests never
                // reach it.
                Layer.mock(AgentRunStore, {}),
                Layer.mock(AgentSession, {}),
                Layer.mock(TeachingRecordingStore, {
                  catalogRoot: () => flow,
                  directory: () => path.join(flow, "recordings", recordingId),
                  read: () => Effect.succeed(manifest(videoPath)),
                }),
                Layer.mock(RunVideoRenderer, {
                  status: (directory) => {
                    asked.push(directory);
                    return Effect.succeed({
                      condensed: true,
                      path: path.join(directory, "run.webm"),
                      state: "ready",
                    } satisfies RunVideoStatus);
                  },
                })
              )
            ),
            Layer.provideMerge(NodeHttpPlatform.layer),
            Layer.provideMerge(NodeServices.layer)
          ),
          { disableLogger: true }
        );
      const request = (handler: ReturnType<typeof serve>, target: string) =>
        Effect.promise(() =>
          handler.handler(
            new Request(`${origin}${target}`, {
              headers: { host: "127.0.0.1:7777" },
            })
          )
        );
      const condensed = serve("run.webm");
      const legacy = serve("legacy.webm");
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await condensed.dispose();
          await legacy.dispose();
        })
      );
      // The renderer is asked about the Run's own folder.
      const status = yield* request(
        condensed,
        `${dryRunVideoPath(recordingId)}/status`
      );
      expect(status.status).toBe(200);
      expect(yield* Effect.promise(() => status.json())).toMatchObject({
        state: "ready",
      });
      expect(asked).toEqual([run]);
      // A video named in the Summary is read from that folder too.
      const video = yield* request(legacy, dryRunVideoPath(recordingId));
      expect(video.status).toBe(200);
      expect(yield* Effect.promise(() => video.text())).toBe("webm");
      const legacyStatus = yield* request(
        legacy,
        `${dryRunVideoPath(recordingId)}/status`
      );
      expect(yield* Effect.promise(() => legacyStatus.json())).toMatchObject({
        path: path.join(run, "legacy.webm"),
        state: "ready",
      });
    }).pipe(Effect.scoped)
);
