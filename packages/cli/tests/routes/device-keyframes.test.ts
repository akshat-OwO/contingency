import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  deviceKeyframesPath,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { makeDeviceKeyframeRoutes } from "../../src/routes/device-keyframes.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";

const hash = ContentHash.make(`sha256-${"a".repeat(64)}`);

it.effect(
  "lists a device session's keyframes and serves only the ones it recorded",
  () =>
    Effect.gen(function* keyframeRoutes() {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "keyframes-"))),
        (owned) =>
          Effect.promise(() => rm(owned, { force: true, recursive: true }))
      );
      yield* Effect.promise(async () => {
        await mkdir(path.join(directory, "keyframes"));
        await writeFile(
          path.join(directory, "keyframes", `${hash}.png`),
          "png"
        );
        await writeFile(path.join(directory, "secret.txt"), "not served");
      });
      const sessionId = AgentSessionId.make("agent-android-ended");
      const origin = "http://127.0.0.1:7777";
      const service = Layer.mock(AndroidWorkspace, {
        keyframes: (id) =>
          Effect.succeed(
            id === sessionId
              ? {
                  directory,
                  keyframes: [
                    {
                      capturedAt: "2026-11-05T00:00:00.000Z",
                      hash,
                      id: "observation-1",
                      kind: "keyframe",
                      path: `keyframes/${hash}.png`,
                    },
                  ],
                }
              : null
          ),
      });
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeDeviceKeyframeRoutes(new Set([origin])).pipe(
              Layer.provide(service),
              // Routes read files per request, from the served context.
              Layer.provideMerge(NodeServices.layer)
            ),
            { disableLogger: true }
          )
        ),
        (owned) => Effect.promise(() => owned.dispose())
      );
      const request = (target: string, host = "127.0.0.1:7777") =>
        Effect.promise(() =>
          web.handler(new Request(`${origin}${target}`, { headers: { host } }))
        );
      const list = yield* request(deviceKeyframesPath("android", sessionId));
      expect(list.status).toBe(200);
      expect(yield* Effect.promise(() => list.json())).toEqual({
        keyframes: [{ capturedAt: "2026-11-05T00:00:00.000Z", hash }],
        retained: true,
      });
      const image = yield* request(
        `${deviceKeyframesPath("android", sessionId)}/${hash}`
      );
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(yield* Effect.promise(() => image.text())).toBe("png");
      // Nothing outside what the session recorded, and nothing for others.
      for (const target of [
        `${deviceKeyframesPath("android", sessionId)}/secret.txt`,
        `${deviceKeyframesPath("android", sessionId)}/sha256-${"b".repeat(64)}`,
        deviceKeyframesPath("android", "agent-other"),
        deviceKeyframesPath("ios", sessionId),
      ]) {
        expect((yield* request(target)).status).toBe(404);
      }
      expect(
        (yield* request(
          deviceKeyframesPath("android", sessionId),
          "evil.example"
        )).status
      ).toBe(404);
      // Once cleanup removed the folder, the list says so.
      yield* Effect.promise(() =>
        rm(directory, { force: true, recursive: true })
      );
      const purged = yield* request(deviceKeyframesPath("android", sessionId));
      expect(yield* Effect.promise(() => purged.json())).toMatchObject({
        retained: false,
      });
    }).pipe(Effect.scoped)
);
