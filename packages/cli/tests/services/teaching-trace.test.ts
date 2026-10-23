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
