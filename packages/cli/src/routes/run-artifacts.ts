import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { RunSession } from "../services/run-session.ts";

/** Where Audit View fetches one attempt's derived video. */
export const runVideoPath = (runId: string, attempt: number): string =>
  `/runs/${encodeURIComponent(runId)}/video/${attempt}`;

/**
 * Video bytes do not travel over RPC. A WebM is megabytes of binary that would
 * have to be framed and buffered through the same socket the Run's progress
 * arrives on; the browser's own media element streams it, seeks it, and caches
 * it if this is a plain HTTP resource instead.
 *
 * The Run's directory holds an unredacted Trace beside that video, so the path
 * is resolved from the Run's own manifest rather than from the request, and
 * the server's loopback bind and allowed-origin handling keep it local
 * ([ADR 0014](../../../../docs/adr/0014-artifacts-are-run-properties.md)).
 */
export const RunArtifactRoutes = HttpRouter.add(
  "GET",
  "/runs/:runId/video/:attempt",
  Effect.gen(function* serveRunVideo() {
    const parameters = yield* HttpRouter.params;
    const session = yield* RunSession;
    const runId = parameters.runId ?? "";
    const attempt = Number(parameters.attempt);
    if (!Number.isInteger(attempt)) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const resolved = yield* Effect.result(
      session.artifactPath(runId, attempt, "video")
    );
    if (resolved._tag === "Failure") {
      return HttpServerResponse.empty({ status: 404 });
    }
    return yield* HttpServerResponse.file(resolved.success, {
      contentType: "video/webm",
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 }))
      )
    );
  })
);
