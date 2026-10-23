import { isUtf8 } from "node:buffer";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect, Schema } from "effect";
import { yauzl, yazl } from "playwright-core/lib/utilsBundle";

import { redactDevtoolsJson, redactDevtoolsText } from "./browser-devtools.ts";

/** Preserve JSON syntax and binary bytes while using the existing private-value redactor. */
const redactEntry = (
  contents: Buffer,
  name: string,
  values: readonly string[]
): Buffer => {
  if (/\.(?:trace|network|stacks)$/u.test(name)) {
    return Buffer.from(
      contents
        .toString("utf-8")
        .split("\n")
        .map((line) => {
          if (line.trim().length === 0) {
            return line;
          }
          const value = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(line));
          return JSON.stringify(redactDevtoolsJson(value, values));
        })
        .join("\n")
    );
  }
  if (isUtf8(contents)) {
    return Buffer.from(redactDevtoolsText(contents.toString("utf-8"), values));
  }
  // Latin-1 maps each byte to one code point, so non-text resources survive.
  return Buffer.from(
    redactDevtoolsText(
      contents.toString("latin1"),
      values.map((value) => Buffer.from(value).toString("latin1"))
    ),
    "latin1"
  );
};

/** Finalize Trace privacy before the recorder publishes or hashes its artifacts. */
export const redactTeachingTrace = (
  file: string,
  sensitiveValues: readonly string[]
) =>
  Effect.tryPromise({
    catch: () =>
      makeBrowserRpcError(
        "agent_browser_failed",
        "Could not redact the Teaching Trace"
      ),
    try: async (signal) => {
      if (sensitiveValues.length === 0) {
        return;
      }
      const temporary = `${file}.redacting`;
      try {
        const source = await yauzl.openPromise(file, { lazyEntries: true });
        const destination = new yazl.ZipFile();
        const write = pipeline(
          destination.outputStream,
          createWriteStream(temporary, { mode: 0o600 }),
          { signal }
        );
        await Promise.all([
          write,
          (async () => {
            try {
              for await (const entry of source.eachEntry()) {
                if (!entry.fileName.endsWith("/")) {
                  const contents = await buffer(
                    await source.openReadStreamPromise(entry)
                  );
                  destination.addBuffer(
                    redactEntry(contents, entry.fileName, sensitiveValues),
                    entry.fileName
                  );
                }
              }
              destination.end();
            } catch (error) {
              destination.outputStream.destroy(
                error instanceof Error
                  ? error
                  : new Error("Trace redaction failed")
              );
              throw error;
            } finally {
              source.close();
            }
          })(),
        ]);
        await rename(temporary, file);
      } catch {
        // A failed scrub must never publish the original private Trace.
        await rm(file, { force: true });
        throw new Error("Trace redaction failed");
      } finally {
        await rm(temporary, { force: true });
      }
    },
  });
