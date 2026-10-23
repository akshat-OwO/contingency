import { createWriteStream } from "node:fs";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { yauzl, yazl } from "playwright-core/lib/utilsBundle";

import { redactTeachingTrace } from "../../src/services/teaching-trace.ts";

it.effect(
  "redacts private Trace strings without corrupting JSON or binary resources",
  () =>
    Effect.gen(function* redactArchive() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "trace.zip");
      yield* Effect.promise(async () => {
        const zip = new yazl.ZipFile();
        zip.addBuffer(
          Buffer.from(
            `${JSON.stringify({ escaped: 'private"value', flag: true, value: "true" })}\n`
          ),
          "trace.trace"
        );
        zip.addBuffer(Buffer.from([0, 255, 128, 1]), "resources/binary");
        zip.addBuffer(Buffer.from("private%22value"), "resources/text");
        zip.end();
        await pipeline(zip.outputStream, createWriteStream(file));
      });
      yield* redactTeachingTrace(file, ["true", 'private"value']);
      yield* Effect.promise(async () => {
        const zip = await yauzl.openPromise(file, { lazyEntries: true });
        for await (const entry of zip.eachEntry()) {
          const bytes = await buffer(await zip.openReadStreamPromise(entry));
          if (entry.fileName === "trace.trace") {
            expect(JSON.parse(bytes.toString())).toEqual({
              escaped: "[sensitive input]",
              flag: true,
              value: "[sensitive input]",
            });
          } else if (entry.fileName === "resources/binary") {
            expect(bytes).toEqual(Buffer.from([0, 255, 128, 1]));
          } else {
            expect(bytes.toString()).toBe("[sensitive input]");
          }
        }
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("removes a Trace that cannot be scrubbed", () =>
  Effect.gen(function* refuseUnreadableTrace() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const file = path.join(directory, "trace.zip");
    yield* fs.writeFileString(file, "private-value in a corrupt archive");
    const failure = yield* Effect.flip(
      redactTeachingTrace(file, ["private-value"])
    );
    expect(failure.message).toBe("Could not redact the Teaching Trace");
    expect(yield* fs.readDirectory(directory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "omits attached and embedded bodies while retaining redacted network metadata",
  () =>
    Effect.gen(function* omitOpaqueBodies() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "trace.zip");
      const secret = "private-body";
      const encoded = Buffer.from(secret).toString("base64");
      yield* Effect.promise(async () => {
        const zip = new yazl.ZipFile();
        // Resources can precede their references in the archive.
        zip.addBuffer(Buffer.from(encoded), "resources/response.jsonl");
        zip.addBuffer(Buffer.from(encoded), "resources/request");
        zip.addBuffer(
          Buffer.from([0, 255, ...Buffer.from(encoded)]),
          "resources/binary-body"
        );
        zip.addBuffer(
          Buffer.from(
            `${JSON.stringify({ data: encoded, opcode: 2, time: 1, type: "receive" })}\n`
          ),
          "resources/socket.jsonl"
        );
        zip.addBuffer(
          Buffer.from(
            [
              {
                snapshot: {
                  request: { postData: { _sha1: "request" }, url: secret },
                  response: { content: { _file: "resources/response.jsonl" } },
                },
                type: "resource-snapshot",
              },
              {
                snapshot: {
                  response: { content: { _file: "resources/binary-body" } },
                },
                type: "resource-snapshot",
              },
              {
                snapshot: {
                  _resourceType: "websocket",
                  response: { content: { _file: "resources/socket.jsonl" } },
                },
                type: "resource-snapshot",
              },
              {
                snapshot: {
                  _webSocketMessages: [
                    { data: encoded, opcode: 1, time: 2, type: "send" },
                  ],
                  response: { content: { encoding: "base64", text: encoded } },
                },
                type: "resource-snapshot",
              },
            ]
              .map((record) => JSON.stringify(record))
              .join("\n")
          ),
          "trace.network"
        );
        zip.end();
        await pipeline(zip.outputStream, createWriteStream(file));
      });
      yield* redactTeachingTrace(file, [secret]);
      yield* Effect.promise(async () => {
        const zip = await yauzl.openPromise(file, { lazyEntries: true });
        try {
          for await (const entry of zip.eachEntry()) {
            const bytes = await buffer(await zip.openReadStreamPromise(entry));
            expect(bytes.toString()).not.toContain(secret);
            expect(bytes.toString()).not.toContain(encoded);
            if (entry.fileName === "trace.network") {
              const records = bytes
                .toString()
                .split("\n")
                .map((line) => JSON.parse(line));
              expect(records[0].snapshot.request.url).toBe("[sensitive input]");
              expect(records[0].snapshot.response.content._file).toBe(
                "resources/response.jsonl"
              );
              expect(
                Buffer.from(
                  records[3].snapshot.response.content.text,
                  "base64"
                ).toString()
              ).toBe("[payload omitted for privacy]");
              expect(records[3].snapshot._webSocketMessages[0].data).toBe(
                "[payload omitted for privacy]"
              );
            } else if (entry.fileName === "resources/socket.jsonl") {
              const frame = JSON.parse(bytes.toString());
              expect(frame).toMatchObject({
                opcode: 2,
                time: 1,
                type: "receive",
              });
              expect(Buffer.from(frame.data, "base64").toString()).toBe(
                "[payload omitted for privacy]"
              );
            } else {
              expect(bytes.toString()).toBe("[payload omitted for privacy]");
            }
          }
        } finally {
          zip.close();
        }
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
