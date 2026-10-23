import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { buffer } from "node:stream/consumers";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Predicate, Schema } from "effect";
import { chromium } from "playwright-core";
import { yauzl } from "playwright-core/lib/utilsBundle";

import { redactTeachingTrace } from "../../src/services/teaching-trace.ts";

const readArchive = async (file: string) => {
  const archive = await yauzl.openPromise(file, { lazyEntries: true });
  const entries = new Map<string, Buffer>();
  try {
    for await (const entry of archive.eachEntry()) {
      entries.set(
        entry.fileName,
        await buffer(await archive.openReadStreamPromise(entry))
      );
    }
  } finally {
    archive.close();
  }
  return entries;
};

const frames = (entries: Map<string, Buffer>) =>
  [...entries]
    .filter(([name]) => name.endsWith(".jsonl"))
    .flatMap(([, bytes]) =>
      bytes
        .toString()
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              data: Schema.String,
              opcode: Schema.Number,
              time: Schema.Number,
              type: Schema.String,
            })
          )(JSON.parse(line))
        )
    );

it.live(
  "omits encoded WebSocket and HTTP payloads from finalized Teaching Traces",
  () =>
    Effect.gen(function* redactCapturedPayloads() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "trace.zip");
      const secret = "trace-private-binary-value";
      const encoded = Buffer.from(secret).toString("base64");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(request.url === "/body" ? encoded : "Trace fixture");
      });
      const sockets = new Set<Duplex>();
      server.on("upgrade", (request, socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        const key = request.headers["sec-websocket-key"];
        if (!Predicate.isString(key)) {
          socket.destroy();
          return;
        }
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        // Acknowledge both frames so tracing stops only after Chromium sent them.
        let received = 0;
        socket.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (
            received >=
            12 + Buffer.byteLength(secret) + Buffer.byteLength(encoded)
          ) {
            socket.end(Buffer.from([0x81, 2, 111, 107]));
          }
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.closeAllConnections();
          server.close(() => resume(Effect.succeed(true)));
        })
      );
      yield* Effect.callback<boolean, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(true)));
      });
      const address = server.address();
      if (address === null || Predicate.isString(address)) {
        return yield* Effect.die("No fixture port");
      }
      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise(() => chromium.launch({ headless: true })),
        (instance) => Effect.promise(() => instance.close())
      );
      yield* Effect.tryPromise(async () => {
        const context = await browser.newContext();
        await context.tracing.start({ screenshots: false, snapshots: true });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.evaluate(
          async ({ privateValue, socketUrl }) => {
            const response = await fetch("/body");
            await response.text();
            const completed = Promise.withResolvers<boolean>();
            const ws = new WebSocket(socketUrl);
            ws.addEventListener(
              "open",
              () => {
                ws.send(new TextEncoder().encode(privateValue));
                ws.send(btoa(privateValue));
              },
              { once: true }
            );
            ws.addEventListener("message", () => completed.resolve(true), {
              once: true,
            });
            ws.addEventListener(
              "error",
              () => completed.reject(new Error("Fixture WebSocket failed")),
              { once: true }
            );
            await completed.promise;
          },
          { privateValue: secret, socketUrl: `ws://127.0.0.1:${address.port}/` }
        );
        await context.tracing.stop({ path: file });
        await context.close();
      });
      const original = yield* Effect.tryPromise(() => readArchive(file));
      const captured = frames(original).filter(
        (frame) => frame.type === "send"
      );
      expect(captured.map((frame) => frame.opcode)).toEqual([2, 1]);
      for (const frame of captured) {
        expect(Buffer.from(frame.data, "base64").toString()).toBe(secret);
      }
      expect(
        [...original.values()].some((bytes) => bytes.toString() === encoded)
      ).toBe(true);
      yield* redactTeachingTrace(file, [secret]);
      const finalized = yield* Effect.tryPromise(() => readArchive(file));
      const retained = frames(finalized).filter(
        (frame) => frame.type === "send"
      );
      expect(retained).toHaveLength(2);
      for (const [index, frame] of retained.entries()) {
        expect({ ...frame, data: "" }).toEqual({
          ...captured[index],
          data: "",
        });
        expect(Buffer.from(frame.data, "base64").toString()).not.toContain(
          secret
        );
        expect(frame.data).not.toBe(captured[index]?.data);
      }
      for (const bytes of finalized.values()) {
        expect(bytes.toString()).not.toContain(secret);
        expect(bytes.toString()).not.toContain(encoded);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
