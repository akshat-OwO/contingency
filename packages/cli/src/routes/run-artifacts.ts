import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { RunSession } from "../services/run-session.ts";

/**
 * Serves one attempt's derived video, at the path the protocol names.
 *
 * The Run's directory holds an unredacted Trace beside that video, so the path
 * is resolved from the Run's own manifest rather than from the request. What
 * keeps the bytes local is the server's loopback bind: a media element sends
 * no `Origin`, so the RPC group's allowed-origin check does not and cannot
 * apply here ([ADR 0014](../../../../docs/adr/0014-artifacts-are-run-properties.md)).
 */
export const RunArtifactRoutes = HttpRouter.add(
  "GET",
  // The pattern behind the protocol's `runVideoPath`, which both sides build
  // requests from; `run-contract.test.ts` pins the shape they must agree on.
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
