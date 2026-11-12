import { createServer } from "node:http";

import {
  encodeIosBuildEntryHeader,
  targetAppBuildPaths,
} from "@contingency/protocol";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { makeTargetAppBuildRoutes } from "../../src/routes/target-app-builds.ts";
import {
  makeTargetAppBuilds,
  TargetAppBuilds,
} from "../../src/services/target-app-builds.ts";

const allowed = "http://127.0.0.1:7777";

const serving = Effect.fn("servingTargetAppBuilds")(function* serving() {
  const builds = yield* makeTargetAppBuilds({
    badging: () => Effect.die("No APKs in this test."),
    plist: () =>
      Effect.succeed(
        JSON.stringify({
          CFBundleExecutable: "Shop",
          CFBundleIdentifier: "dev.shop",
          CFBundleSupportedPlatforms: ["iPhoneSimulator"],
          CFBundleVersion: "3",
        })
      ),
  });
  const context = yield* Layer.build(
    HttpRouter.serve(makeTargetAppBuildRoutes(new Set([allowed]))).pipe(
      Layer.provide(Layer.succeed(TargetAppBuilds, builds)),
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );
  const { address } = Context.get(context, HttpServer.HttpServer);
  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die("Expected a TCP server.");
  }
  return `http://127.0.0.1:${address.port}`;
});

const body = (entries: readonly (readonly [string, string])[]) =>
  Buffer.concat(
    entries.flatMap(([relative, text]) => [
      encodeIosBuildEntryHeader(relative, Buffer.byteLength(text)),
      Buffer.from(text),
    ])
  );

it.live(
  "accepts .app uploads only from the Workspace origin and answers refusals with a reason",
  () =>
    Effect.scoped(
      Effect.gen(function* uploads() {
        const origin = yield* serving();
        const post = (headers: Record<string, string>, payload: Buffer) =>
          Effect.promise(() =>
            fetch(`${origin}${targetAppBuildPaths.ios}`, {
              body: new Uint8Array(payload),
              headers,
              method: "POST",
            })
          );
        const app = body([
          ["Shop.app/Info.plist", "{}"],
          ["Shop.app/Shop", "binary"],
        ]);
        const crossOrigin = yield* post(
          { origin: "https://evil.example" },
          app
        );
        expect(crossOrigin.status).toBe(403);
        const noOrigin = yield* post({}, app);
        expect(noOrigin.status).toBe(403);

        const refused = yield* post(
          { origin: allowed },
          body([["Shop/Info.plist", "{}"]])
        );
        expect(refused.status).toBe(422);
        expect(yield* Effect.promise(() => refused.json())).toMatchObject({
          code: "not_app_bundle",
        });

        const accepted = yield* post({ origin: allowed }, app);
        expect(accepted.status).toBe(200);
        expect(yield* Effect.promise(() => accepted.json())).toMatchObject({
          build: "3",
          bundleId: "dev.shop",
          name: "Shop.app",
        });
      })
    )
);
