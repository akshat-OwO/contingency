import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  DeviceKeyframes,
} from "@contingency/protocol";
import type { DevicePlatform } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AndroidWorkspace } from "../services/android-workspace.ts";
import { IosWorkspace } from "../services/ios-workspace.ts";
import { isAllowedHost } from "../services/web-url.ts";

const isSessionId = Schema.is(AgentSessionId);
const isContentHash = Schema.is(ContentHash);
const listResponse = HttpServerResponse.schemaJson(DeviceKeyframes);
const notFound = HttpServerResponse.empty({ status: 404 });

/** What a device service answers about one session's keyframes. */
type KeyframeSource = (sessionId: AgentSessionId) => Effect.Effect<{
  readonly directory: string;
  readonly keyframes: readonly {
    readonly capturedAt: string;
    readonly hash: string;
    readonly path: string;
  }[];
} | null>;

/**
 * A device session's keyframes, for its Run Summary: the list, and each PNG
 * by its content hash. Only a hash the session itself recorded is served, and
 * only from that session's folder, so the route reads nothing else on disk.
 */
const keyframeRoutes = (
  platform: DevicePlatform,
  allowedOrigins: ReadonlySet<string>,
  source: KeyframeSource | undefined
) => {
  // `deviceKeyframesPath` with the session as a route parameter.
  const base: `/${DevicePlatform}/sessions/:sessionId/keyframes` = `/${platform}/sessions/:sessionId/keyframes`;
  const session = Effect.gen(function* readKeyframeSession() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parameters = yield* HttpRouter.params;
    const sessionId = parameters.sessionId ?? "";
    if (
      source === undefined ||
      !isAllowedHost(request.headers.host, allowedOrigins) ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      !isSessionId(sessionId)
    ) {
      return null;
    }
    const found = yield* source(sessionId);
    return found === null ? null : { found, parameters };
  });
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      base,
      Effect.gen(function* listKeyframes() {
        const fileSystem = yield* FileSystem.FileSystem;
        const resolved = yield* session;
        if (resolved === null) {
          return notFound;
        }
        const { directory, keyframes } = resolved.found;
        // Cleanup can delete the screens and leave the folder, so ask after
        // a screen itself.
        const [first] = keyframes;
        const retained =
          first !== undefined &&
          (yield* fileSystem
            .exists(path.resolve(directory, first.path))
            .pipe(Effect.orElseSucceed(() => false)));
        return yield* listResponse(
          {
            keyframes: keyframes.flatMap((keyframe) =>
              isContentHash(keyframe.hash)
                ? [{ capturedAt: keyframe.capturedAt, hash: keyframe.hash }]
                : []
            ),
            retained,
          },
          { headers: { "cache-control": "no-store" } }
        ).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))
        );
      })
    ),
    HttpRouter.add(
      "GET",
      `${base}/:hash`,
      Effect.gen(function* serveKeyframe() {
        const resolved = yield* session;
        if (resolved === null) {
          return notFound;
        }
        const { directory, keyframes } = resolved.found;
        const keyframe = keyframes.find(
          (entry) => entry.hash === resolved.parameters.hash
        );
        if (keyframe === undefined) {
          return notFound;
        }
        const file = path.resolve(directory, keyframe.path);
        const relative = path.relative(directory, file);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return notFound;
        }
        const fileSystem = yield* FileSystem.FileSystem;
        const bytes = yield* Effect.option(fileSystem.readFile(file));
        // A keyframe is one screen's PNG, so it is read whole. It is content
        // addressed: the same hash is always the same bytes.
        return Option.match(bytes, {
          onNone: () => notFound,
          onSome: (body) =>
            HttpServerResponse.uint8Array(body, {
              contentType: "image/png",
              headers: {
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
              },
            }),
        });
      })
    )
  );
};

/** Keyframe routes for whichever device Workspaces this process runs. */
export const makeDeviceKeyframeRoutes = (allowedOrigins: ReadonlySet<string>) =>
  Layer.unwrap(
    Effect.gen(function* deviceKeyframeRoutes() {
      const android = yield* Effect.serviceOption(AndroidWorkspace);
      const ios = yield* Effect.serviceOption(IosWorkspace);
      return Layer.mergeAll(
        keyframeRoutes(
          "android",
          allowedOrigins,
          Option.isSome(android) ? android.value.keyframes : undefined
        ),
        keyframeRoutes(
          "ios",
          allowedOrigins,
          Option.isSome(ios) ? ios.value.keyframes : undefined
        )
      );
    })
  );
