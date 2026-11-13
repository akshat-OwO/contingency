import { AgentSessionId, DeviceVideoStatus } from "@contingency/protocol";
import type { DevicePlatform } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AndroidWorkspace } from "../services/android-workspace.ts";
import { parseByteRange } from "../services/byte-range.ts";
import { DeviceVideoRenderer } from "../services/device-video-renderer.ts";
import type { DeviceVideoRendererService } from "../services/device-video-renderer.ts";
import { IosWorkspace } from "../services/ios-workspace.ts";
import { isAllowedHost } from "../services/web-url.ts";

const isSessionId = Schema.is(AgentSessionId);
const statusResponse = HttpServerResponse.schemaJson(DeviceVideoStatus);
const notFound = HttpServerResponse.empty({ status: 404 });

/** What a device service answers about where one session's video is. */
type VideoSource = (sessionId: AgentSessionId) => Effect.Effect<{
  readonly folder: string;
  readonly live: boolean;
  readonly purged: boolean;
} | null>;

/**
 * A device session's video, for its Teaching Recording or Run Summary: its
 * status, and the file once it plays. The file served is only the one the
 * status names inside that session's own video folder.
 */
const videoRoutes = (
  platform: DevicePlatform,
  allowedOrigins: ReadonlySet<string>,
  source: VideoSource | undefined,
  renderer: DeviceVideoRendererService | undefined
) => {
  // `deviceVideoPath` with the session as a route parameter.
  const base: `/${DevicePlatform}/sessions/:sessionId/video` = `/${platform}/sessions/:sessionId/video`;
  const status = Effect.gen(function* readVideoStatus() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parameters = yield* HttpRouter.params;
    const sessionId = parameters.sessionId ?? "";
    if (
      source === undefined ||
      renderer === undefined ||
      !isAllowedHost(request.headers.host, allowedOrigins) ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      !isSessionId(sessionId)
    ) {
      return null;
    }
    const found = yield* source(sessionId);
    if (found === null) {
      return null;
    }
    if (found.purged) {
      return { state: "purged" } satisfies DeviceVideoStatus;
    }
    return yield* renderer.status(found.folder, found.live);
  });
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${base}/status`,
      Effect.gen(function* serveVideoStatus() {
        const current = yield* status;
        if (current === null) {
          return notFound;
        }
        return yield* statusResponse(current, {
          headers: { "cache-control": "no-store" },
        }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))
        );
      })
    ),
    HttpRouter.add(
      "GET",
      base,
      Effect.gen(function* serveVideo() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const current = yield* status;
        if (current?.state !== "ready") {
          return notFound;
        }
        const fileSystem = yield* FileSystem.FileSystem;
        const info = yield* Effect.option(fileSystem.stat(current.path));
        if (Option.isNone(info)) {
          return notFound;
        }
        const size = Number(info.value.size);
        const range = parseByteRange(request.headers.range, size);
        const cached = {
          "accept-ranges": "bytes",
          // Device video is Teaching or Run evidence that Cleanup can purge,
          // so the browser keeps no copy that would outlive it.
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        const headers =
          range === undefined
            ? cached
            : {
                ...cached,
                "content-range": `bytes ${range.start}-${range.end}/${size}`,
              };
        return yield* HttpServerResponse.file(current.path, {
          bytesToRead:
            range === undefined ? undefined : range.end - range.start + 1,
          contentType: current.path.endsWith(".webm")
            ? "video/webm"
            : "video/mp4",
          headers,
          offset: range?.start,
          status: range === undefined ? 200 : 206,
        }).pipe(Effect.catchCause(() => Effect.succeed(notFound)));
      })
    )
  );
};

/** Video routes for whichever device Workspaces this process runs. */
export const makeDeviceVideoRoutes = (allowedOrigins: ReadonlySet<string>) =>
  Layer.unwrap(
    Effect.gen(function* deviceVideoRoutes() {
      const android = yield* Effect.serviceOption(AndroidWorkspace);
      const ios = yield* Effect.serviceOption(IosWorkspace);
      const renderer = Option.getOrUndefined(
        yield* Effect.serviceOption(DeviceVideoRenderer)
      );
      return Layer.mergeAll(
        videoRoutes(
          "android",
          allowedOrigins,
          Option.isSome(android) ? android.value.video : undefined,
          renderer
        ),
        videoRoutes(
          "ios",
          allowedOrigins,
          Option.isSome(ios) ? ios.value.video : undefined,
          renderer
        )
      );
    })
  );
