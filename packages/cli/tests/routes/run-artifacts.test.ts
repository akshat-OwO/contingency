import { createServer, request } from "node:http";
import path from "node:path";

import { makeBrowserRpcError } from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import {
  makeRunArtifactRoutes,
  parseByteRange,
} from "../../src/routes/run-artifacts.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";
import { isAllowedHost } from "../../src/services/web-url.ts";

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
    HttpRouter.serve(
      makeRunArtifactRoutes({
        allowedOrigins: new Set(["http://audit.example:7777"]),
      })
    ).pipe(
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

it("serves a loopback or configured Host, and nothing a rebind can present", () => {
  const allowed = new Set(["http://audit.example:7777"]);
  // A media element sends no Origin, so Host is the only name a request
  // carries. Loopback literals and the configured origin are servable.
  expect(isAllowedHost("127.0.0.1:7777", allowed)).toBe(true);
  expect(isAllowedHost("localhost:5173", allowed)).toBe(true);
  expect(isAllowedHost("[::1]:7777", allowed)).toBe(true);
  expect(isAllowedHost("audit.example:7777", allowed)).toBe(true);

  // Shorthand normalises to a loopback literal before this sees it.
  expect(isAllowedHost("127.1:7777", allowed)).toBe(true);

  // A DNS rebind reaches the loopback bind but carries the attacker's own
  // name, which is what this refuses — including a name that merely looks
  // like a loopback address, which an attacker can register and rebind.
  expect(isAllowedHost("rebind.evil:7777", allowed)).toBe(false);
  expect(isAllowedHost("127.0.0.1.evil.com:7777", allowed)).toBe(false);
  expect(isAllowedHost("127.com:7777", allowed)).toBe(false);
  expect(isAllowedHost("localhost.evil:7777", allowed)).toBe(false);
  expect(isAllowedHost("audit.example.evil:7777", allowed)).toBe(false);
  // HTTP/1.1 requires a Host; one that is absent or unparseable is refused.
  expect(isAllowedHost(undefined, allowed)).toBe(false);
  expect(isAllowedHost("", allowed)).toBe(false);
});

it.live("refuses a request carrying a Host that is not ours", () =>
  Effect.gen(function* refusesRebind() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "attempt-1.webm");
    yield* fileSystem.writeFile(file, videoBytes);
    const origin = yield* serving(file);

    // `fetch` refuses to set Host, so the request is made by hand: a rebinding
    // browser sends the attacker's name here while reaching the loopback bind.
    const status = yield* Effect.callback<number>((resume) => {
      const call = request(
        `${origin}/runs/run-1/video/1`,
        { headers: { host: "rebind.evil:7777" } },
        (response) => {
          response.resume();
          resume(Effect.succeed(response.statusCode ?? 0));
        }
      );
      call.end();
    });
    expect(status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
