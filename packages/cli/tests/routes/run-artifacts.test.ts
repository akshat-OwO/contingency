import { createServer } from "node:http";
import path from "node:path";

import { makeBrowserRpcError } from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import {
  RunArtifactRoutes,
  parseByteRange,
} from "../../src/routes/run-artifacts.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";

it("reads the one byte range a media element asks for", () => {
  expect(parseByteRange("bytes=0-99", 500)).toEqual({ end: 99, start: 0 });
  // An open end is the rest of the file, which is what a seek sends.
  expect(parseByteRange("bytes=200-", 500)).toEqual({ end: 499, start: 200 });
  // A suffix range asks for the last bytes, where a WebM keeps its Cues.
  expect(parseByteRange("bytes=-100", 500)).toEqual({ end: 499, start: 400 });
  // Past the end, malformed, absent, or multi-range: serve the whole file.
  expect(parseByteRange("bytes=900-999", 500)).toBeUndefined();
  expect(parseByteRange("bytes=0-99,200-299", 500)).toBeUndefined();
  expect(parseByteRange(undefined, 500)).toBeUndefined();
  expect(parseByteRange("bytes=0-99", 0)).toBeUndefined();
});

const videoBytes = Buffer.from("0123456789abcdefghij", "utf-8");

const sessionServing = (file: string): RunSessionService => ({
  answerVariable: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
  artifactPath: (runId) =>
    runId === "run-1"
      ? Effect.succeed(file)
      : Effect.fail(
          makeBrowserRpcError("run_invalid", "That Run is not loaded.")
        ),
  changes: () => Stream.never,
  get: () => Effect.succeed(null),
  loadFlow: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
  start: () =>
    Effect.fail(makeBrowserRpcError("run_invalid", "Not under test.")),
});

/** Serves the route on an ephemeral port and hands back its origin. */
const serving = Effect.fn("serving")(function* serving(file: string) {
  const context = yield* Layer.build(
    HttpRouter.serve(RunArtifactRoutes).pipe(
      Layer.provide(Layer.succeed(RunSession, sessionServing(file))),
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const { address } = server;
  return address._tag === "TcpAddress"
    ? `http://127.0.0.1:${address.port}`
    : "";
});

it.live("answers a byte range, so a player can seek to a Step's frame", () =>
  Effect.gen(function* servesRanges() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "attempt-1.webm");
    yield* fileSystem.writeFile(file, videoBytes);
    const origin = yield* serving(file);

    const whole = yield* Effect.promise(() =>
      fetch(`${origin}/runs/run-1/video/1`)
    );
    expect(whole.status).toBe(200);
    // Advertised on every response: without it a player never asks for a range
    // and cannot seek past what it happened to buffer.
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-type")).toContain("video/webm");
    expect(yield* Effect.promise(() => whole.text())).toBe(
      videoBytes.toString()
    );

    const ranged = yield* Effect.promise(() =>
      fetch(`${origin}/runs/run-1/video/1`, { headers: { range: "bytes=4-8" } })
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 4-8/20");
    expect(yield* Effect.promise(() => ranged.text())).toBe("45678");

    const missing = yield* Effect.promise(() =>
      fetch(`${origin}/runs/other/video/1`)
    );
    expect(missing.status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
