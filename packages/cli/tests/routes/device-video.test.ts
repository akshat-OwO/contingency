import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentSessionId,
  deviceVideoPath,
  deviceVideoStatusPath,
} from "@contingency/protocol";
import type { DeviceVideoStatus } from "@contingency/protocol";
import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { makeDeviceVideoRoutes } from "../../src/routes/device-video.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { DeviceVideoRenderer } from "../../src/services/device-video-renderer.ts";

it.effect(
  "serves a device session's video status and only the file it names",
  () =>
    Effect.gen(function* videoRoutes() {
      const folder = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "device-video-"))),
        (owned) =>
          Effect.promise(() => rm(owned, { force: true, recursive: true }))
      );
      const video = path.join(folder, "video.webm");
      yield* Effect.promise(() => writeFile(video, "0123456789"));
      const ready = AgentSessionId.make("agent-android-ready");
      const purged = AgentSessionId.make("agent-android-purged");
      const preparing = AgentSessionId.make("agent-android-preparing");
      const origin = "http://127.0.0.1:7777";
      const statuses = new Map<string, DeviceVideoStatus>([
        [
          folder,
          {
            capture: { complete: true, gaps: [], hidden: [] },
            pacing: "real-time",
            path: video,
            state: "ready",
            timeMap: {
              fastForward: "capped",
              segments: [],
              startedAt: "2026-11-13T00:00:00.000Z",
            },
          },
        ],
        [`${folder}-preparing`, { state: "preparing" }],
      ]);
      const workspace = Layer.mock(AndroidWorkspace, {
        video: (id) =>
          Effect.succeed(
            {
              [preparing]: {
                folder: `${folder}-preparing`,
                live: true,
                purged: false,
              },
              [purged]: { folder, live: false, purged: true },
              [ready]: { folder, live: false, purged: false },
            }[id] ?? null
          ),
      });
      const renderer = Layer.mock(DeviceVideoRenderer, {
        status: (at) =>
          Effect.succeed(
            statuses.get(at) ?? { reason: "Unknown.", state: "not-recorded" }
          ),
      });
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeDeviceVideoRoutes(new Set([origin])).pipe(
              Layer.provide(Layer.merge(workspace, renderer)),
              // Files are served through the platform, as the server does.
              Layer.provideMerge(NodeHttpPlatform.layer),
              Layer.provideMerge(NodeServices.layer)
            ),
            { disableLogger: true }
          )
        ),
        (owned) => Effect.promise(() => owned.dispose())
      );
      const request = (target: string, headers: Record<string, string> = {}) =>
        Effect.promise(() =>
          web.handler(
            new Request(`${origin}${target}`, {
              headers: { host: "127.0.0.1:7777", ...headers },
            })
          )
        );
      const status = yield* request(deviceVideoStatusPath("android", ready));
      expect(status.status).toBe(200);
      expect(yield* Effect.promise(() => status.json())).toMatchObject({
        pacing: "real-time",
        state: "ready",
      });
      const whole = yield* request(deviceVideoPath("android", ready));
      expect(whole.status).toBe(200);
      expect(whole.headers.get("content-type")).toBe("video/webm");
      expect(whole.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => whole.text())).toBe("0123456789");
      const part = yield* request(deviceVideoPath("android", ready), {
        range: "bytes=2-5",
      });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(yield* Effect.promise(() => part.text())).toBe("2345");

      // Cleanup's purge is said, not served.
      const gone = yield* request(deviceVideoStatusPath("android", purged));
      expect(yield* Effect.promise(() => gone.json())).toEqual({
        state: "purged",
      });
      for (const target of [
        deviceVideoPath("android", purged),
        deviceVideoPath("android", preparing),
        deviceVideoStatusPath(
          "android",
          AgentSessionId.make("agent-android-unknown")
        ),
        // iOS runs no workspace in this process.
        deviceVideoStatusPath("ios", ready),
      ]) {
        expect((yield* request(target)).status).toBe(404);
      }
      // Another site, or a request naming another host, reads nothing.
      expect(
        (yield* request(deviceVideoStatusPath("android", ready), {
          "sec-fetch-site": "cross-site",
        })).status
      ).toBe(404);
      expect(
        (yield* request(deviceVideoStatusPath("android", ready), {
          host: "attacker.example",
        })).status
      ).toBe(404);
    }).pipe(Effect.scoped)
);
