import { AgentRunId } from "@contingency/protocol";
import { Effect, FileSystem, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { AgentRunStore } from "../services/agent-run-store.ts";
import { isAllowedHost } from "../services/web-url.ts";
import { parseByteRange } from "./run-artifacts.ts";

const isAgentRunId = Schema.is(AgentRunId);

/**
 * Serves one finished Interactive Run's video from the Run's own directory.
 *
 * The video is unredacted local evidence and can carry secret Variable values,
 * so the path is resolved from the persisted Run Summary rather than from the
 * request, and the `Host` is checked against the same origins the RPC group
 * allows: a media element sends no `Origin`, and the loopback bind alone does
 * not stop a remote page rebinding a name it controls to 127.0.0.1
 * ([ADR 0010](../../../../docs/adr/0010-run-video-is-unredacted.md)).
 *
 * Nothing here uploads: the Run Summary embeds this local URL and no adapter
 * transmits the file elsewhere without direct user confirmation.
 */
export const makeAgentRunArtifactRoutes = ({
  allowedOrigins,
}: {
  readonly allowedOrigins: ReadonlySet<string>;
}) =>
  HttpRouter.add(
    "GET",
    // The pattern behind the protocol's `agentRunVideoPath`, which Agent View
    // builds its requests from.
    "/agent-runs/:runId/video",
    Effect.gen(function* serveAgentRunVideo() {
      const parameters = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* AgentRunStore;
      if (!isAllowedHost(request.headers.host, allowedOrigins)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const runId = parameters.runId ?? "";
      // The identifier is validated before it reaches the store, so a request
      // cannot name a path outside the Run directories it addresses.
      if (!isAgentRunId(runId)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const resolved = yield* Effect.result(store.videoFile(runId));
      if (resolved._tag === "Failure" || resolved.success === null) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const file = resolved.success;
      const info = yield* Effect.result(fileSystem.stat(file));
      if (info._tag === "Failure") {
        return HttpServerResponse.empty({ status: 404 });
      }
      const size = Number(info.success.size);
      const range = parseByteRange(request.headers.range, size);
      return yield* HttpServerResponse.file(file, {
        bytesToRead:
          range === undefined ? undefined : range.end - range.start + 1,
        contentType: "video/webm",
        headers: {
          "accept-ranges": "bytes",
          ...(range === undefined
            ? {}
            : { "content-range": `bytes ${range.start}-${range.end}/${size}` }),
        },
        offset: range?.start,
        status: range === undefined ? 200 : 206,
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      );
    })
  );
