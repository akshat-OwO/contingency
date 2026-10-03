import path from "node:path";

import {
  AgentRunId,
  RunVideoStatus,
  TeachingRecordingId,
} from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AgentRunStore } from "../services/agent-run-store.ts";
import { AgentSession } from "../services/agent-session.ts";
import { parseByteRange } from "../services/byte-range.ts";
import {
  RUN_VIDEO_FILE,
  RunVideoRenderer,
} from "../services/run-video-renderer.ts";
import { TeachingRecordingStore } from "../services/teaching-recording-store.ts";
import { isAllowedHost } from "../services/web-url.ts";

const isAgentRunId = Schema.is(AgentRunId);
const isTeachingRecordingId = Schema.is(TeachingRecordingId);

const statusResponse = HttpServerResponse.schemaJson(RunVideoStatus);

/**
 * A finished Run's video is condensed after its Summary is written, so the
 * Workspace asks whether it is ready before pointing a media element at it.
 * The answer changes as the encode runs, so it is never cached.
 */
const videoStatus = (status: RunVideoStatus) =>
  statusResponse(status, { headers: { "cache-control": "no-store" } }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))
  );

const unavailable: RunVideoStatus = { state: "unavailable" };

/**
 * The status of the video a Summary names. Only `run.webm` is condensed; a
 * Run recorded before Runs condensed their videos kept Playwright's real-time
 * recording under another name, and is served as it is.
 */
const statusOf = (directory: string, videoName: string) =>
  Effect.gen(function* readVideoStatus() {
    if (videoName === RUN_VIDEO_FILE) {
      const renderer = yield* RunVideoRenderer;
      return yield* renderer.status(directory);
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const present = yield* fileSystem
      .exists(path.join(directory, videoName))
      .pipe(Effect.orElseSucceed(() => false));
    return present
      ? ({
          condensed: false,
          reason: "This Run was recorded before Run videos were condensed.",
          state: "ready",
        } satisfies RunVideoStatus)
      : unavailable;
  });

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
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/agent-runs/:runId/video/status",
      Effect.gen(function* serveAgentRunVideoStatus() {
        const parameters = yield* HttpRouter.params;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const store = yield* AgentRunStore;
        if (!isAllowedHost(request.headers.host, allowedOrigins)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const runId = parameters.runId ?? "";
        if (!isAgentRunId(runId)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const resolved = yield* Effect.result(store.videoFile(runId));
        if (resolved._tag === "Failure") {
          return HttpServerResponse.empty({ status: 404 });
        }
        return yield* videoStatus(
          resolved.success === null
            ? unavailable
            : yield* statusOf(
                path.dirname(resolved.success),
                path.basename(resolved.success)
              )
        );
      })
    ),
    scanArtifactRoute(allowedOrigins, false),
    agentRunVideoRoute(allowedOrigins)
  );

const agentRunVideoRoute = (allowedOrigins: ReadonlySet<string>) =>
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
      const headers =
        range === undefined
          ? { "accept-ranges": "bytes" }
          : {
              "accept-ranges": "bytes",
              "content-range": `bytes ${range.start}-${range.end}/${size}`,
            };
      return yield* HttpServerResponse.file(file, {
        bytesToRead:
          range === undefined ? undefined : range.end - range.start + 1,
        contentType: "video/webm",
        headers,
        offset: range?.start,
        status: range === undefined ? 200 : 206,
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      );
    })
  );

/** Serve the latest Dry Run video only while its Teaching Recording exists. */
export const makeDryRunArtifactRoutes = ({
  allowedOrigins,
}: {
  readonly allowedOrigins: ReadonlySet<string>;
}) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/teaching-recordings/:recordingId/dry-run/video/status",
      Effect.gen(function* serveDryRunVideoStatus() {
        const parameters = yield* HttpRouter.params;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const store = yield* TeachingRecordingStore;
        if (!isAllowedHost(request.headers.host, allowedOrigins)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const recordingId = parameters.recordingId ?? "";
        if (!isTeachingRecordingId(recordingId)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const manifest = yield* Effect.result(store.read(recordingId));
        if (
          manifest._tag === "Failure" ||
          (manifest.success.lifecycle._tag !== "dry-run-passed" &&
            manifest.success.lifecycle._tag !== "dry-run-failed")
        ) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const videoPath = manifest.success.lifecycle.dryRunSummary?.videoPath;
        if (
          videoPath === null ||
          videoPath === undefined ||
          path.basename(videoPath) !== videoPath
        ) {
          return yield* videoStatus(unavailable);
        }
        return yield* videoStatus(
          yield* statusOf(
            path.join(store.directory(recordingId), "dry-run"),
            videoPath
          )
        );
      })
    ),
    scanArtifactRoute(allowedOrigins, true),
    dryRunVideoRoute(allowedOrigins)
  );

const dryRunVideoRoute = (allowedOrigins: ReadonlySet<string>) =>
  HttpRouter.add(
    "GET",
    "/teaching-recordings/:recordingId/dry-run/video",
    Effect.gen(function* serveDryRunVideo() {
      const parameters = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* TeachingRecordingStore;
      if (!isAllowedHost(request.headers.host, allowedOrigins)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const recordingId = parameters.recordingId ?? "";
      if (!isTeachingRecordingId(recordingId)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const manifest = yield* Effect.result(store.read(recordingId));
      if (
        manifest._tag === "Failure" ||
        (manifest.success.lifecycle._tag !== "dry-run-passed" &&
          manifest.success.lifecycle._tag !== "dry-run-failed")
      ) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const videoPath = manifest.success.lifecycle.dryRunSummary?.videoPath;
      if (
        videoPath === null ||
        videoPath === undefined ||
        path.basename(videoPath) !== videoPath
      ) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const file = path.join(
        store.directory(recordingId),
        "dry-run",
        videoPath
      );
      const info = yield* Effect.result(fileSystem.stat(file));
      if (info._tag === "Failure") {
        return HttpServerResponse.empty({ status: 404 });
      }
      const size = Number(info.success.size);
      const range = parseByteRange(request.headers.range, size);
      const headers =
        range === undefined
          ? { "accept-ranges": "bytes" }
          : {
              "accept-ranges": "bytes",
              "content-range": `bytes ${range.start}-${range.end}/${size}`,
            };
      return yield* HttpServerResponse.file(file, {
        bytesToRead:
          range === undefined ? undefined : range.end - range.start + 1,
        contentType: "video/webm",
        headers,
        offset: range?.start,
        status: range === undefined ? 200 : 206,
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      );
    })
  );

const liveDryRunScan = (sessionId: AgentSessionId, reportId: string) =>
  Effect.gen(function* locateLiveDryRunScan() {
    const session = yield* AgentSession;
    const live = yield* Effect.result(session.get(sessionId));
    if (
      live._tag === "Failure" ||
      live.success.run === null ||
      !("runId" in live.success.run)
    ) {
      return null;
    }
    return yield* session
      .scanArtifact(live.success.run.runId, reportId)
      .pipe(Effect.orElseSucceed(() => null));
  });

const scanArtifactRoute = (
  allowedOrigins: ReadonlySet<string>,
  dryRun: boolean
) =>
  HttpRouter.add(
    "GET",
    dryRun
      ? "/teaching-recordings/:recordingId/dry-run/scans/:reportId"
      : "/agent-runs/:runId/scans/:reportId",
    Effect.gen(function* serveScanReport() {
      const parameters = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isAllowedHost(request.headers.host, allowedOrigins)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const reportId = parameters.reportId ?? "";
      if (!/^scan-[a-f0-9-]+$/u.test(reportId)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      let file: string | null = null;
      if (dryRun) {
        const recordingId = parameters.recordingId ?? "";
        if (!isTeachingRecordingId(recordingId)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const store = yield* TeachingRecordingStore;
        const manifest = yield* Effect.result(store.read(recordingId));
        if (manifest._tag === "Success") {
          if ("dryRunSessionId" in manifest.success.lifecycle) {
            file = yield* liveDryRunScan(
              manifest.success.lifecycle.dryRunSessionId,
              reportId
            );
          }
          const summary =
            "dryRunSummary" in manifest.success.lifecycle
              ? manifest.success.lifecycle.dryRunSummary
              : undefined;
          if (
            summary?.schemaVersion === 3 &&
            summary.scanReports?.some(
              (scan) =>
                scan.id === reportId &&
                scan.reportPath === `scans/${reportId}.json`
            )
          ) {
            file = path.join(
              store.directory(recordingId),
              "dry-run",
              `scans/${reportId}.json`
            );
          }
        }
      } else {
        const runId = parameters.runId ?? "";
        if (!isAgentRunId(runId)) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const session = yield* AgentSession;
        const live = yield* Effect.result(
          session.scanArtifact(runId, reportId)
        );
        if (live._tag === "Success") {
          file = live.success;
        } else {
          const store = yield* AgentRunStore;
          file = yield* store
            .scanFile(runId, reportId)
            .pipe(Effect.orElseSucceed(() => null));
        }
      }
      if (file === null) {
        return HttpServerResponse.empty({ status: 404 });
      }
      return yield* HttpServerResponse.file(file, {
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="${reportId}.json"`,
        },
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      );
    })
  );
