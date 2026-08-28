import { Effect, FileSystem } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { RunSession } from "../services/run-session.ts";

export interface ByteRange {
  readonly end: number;
  readonly start: number;
}

/**
 * The single byte range a request asked for, or `undefined` for the whole
 * file. Only the one-range form is honoured, which is the only form a media
 * element sends.
 */
export const parseByteRange = (
  header: string | undefined,
  size: number
): ByteRange | undefined => {
  const match = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(header?.trim() ?? "");
  if (match === null || size === 0) {
    return undefined;
  }
  const { end, start } = match.groups ?? {};
  if (
    start === undefined ||
    end === undefined ||
    (start === "" && end === "")
  ) {
    return undefined;
  }
  // A suffix range — `bytes=-1024` — asks for the file's last N bytes.
  const from = start === "" ? Math.max(size - Number(end), 0) : Number(start);
  const to =
    start === "" || end === "" ? size - 1 : Math.min(Number(end), size - 1);
  return from > to || from >= size ? undefined : { end: to, start: from };
};

/**
 * Serves one attempt's derived video, at the path the protocol names.
 *
 * The Run's directory holds an unredacted Trace beside that video, so the path
 * is resolved from the Run's own manifest rather than from the request. What
 * keeps the bytes local is the server's loopback bind: a media element sends
 * no `Origin`, so the RPC group's allowed-origin check does not and cannot
 * apply here ([ADR 0014](../../../../docs/adr/0014-artifacts-are-run-properties.md)).
 *
 * Byte ranges are answered, because seeking depends on them: a player asked to
 * show a Step's frame that cannot fetch the bytes around it stays on the first
 * frame, which is indistinguishable from a broken seek.
 */
export const RunArtifactRoutes = HttpRouter.add(
  "GET",
  // The pattern behind the protocol's `runVideoPath`, which both sides build
  // requests from; `run-contract.test.ts` pins the shape they must agree on.
  "/runs/:runId/video/:attempt",
  Effect.gen(function* serveRunVideo() {
    const parameters = yield* HttpRouter.params;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fileSystem = yield* FileSystem.FileSystem;
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
          : {
              "content-range": `bytes ${range.start}-${range.end}/${size}`,
            }),
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
