import { isUtf8 } from "node:buffer";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect, Predicate, Schema } from "effect";
import { yauzl, yazl } from "playwright-core/lib/utilsBundle";

import { redactDevtoolsJson, redactDevtoolsText } from "./browser-devtools.ts";

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

const omittedPayload = "[payload omitted for privacy]";

/** Opaque payloads can contain application encodings the text redactor cannot inspect. */
const omitPayloads = (value: Schema.Json): Schema.Json => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }
  if (isJsonArray(value)) {
    return value.map(omitPayloads);
  }
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, omitPayloads(item)])
  );
  if (
    (value.type === "send" || value.type === "receive") &&
    Predicate.isNumber(value.opcode) &&
    Predicate.isString(value.data)
  ) {
    result.data =
      value.opcode === 1
        ? omittedPayload
        : Buffer.from(omittedPayload).toString("base64");
  }
  if (value.encoding === "base64" && Predicate.isString(value.text)) {
    result.text = Buffer.from(omittedPayload).toString("base64");
  }
  return result;
};

const decodeJson = (line: string) =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(line));

/** Network bodies are attached as raw resources, with no reliable application encoding. */
const collectBodyResources = (
  value: Schema.Json,
  resources: Set<string>,
  sockets: Set<string>
): void => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return;
  }
  if (isJsonArray(value)) {
    for (const item of value) {
      collectBodyResources(item, resources, sockets);
    }
    return;
  }
  // Playwright uses _file for current traces and _sha1 for older attached bodies.
  if (Predicate.isString(value._file)) {
    resources.add(value._file);
  }
  if (Predicate.isString(value._sha1)) {
    resources.add(`resources/${value._sha1}`);
  }
  for (const item of Object.values(value)) {
    collectBodyResources(
      item,
      value._resourceType === "websocket" ? sockets : resources,
      sockets
    );
  }
};

const bodyResources = async (file: string) => {
  const resources = new Set<string>();
  const sockets = new Set<string>();
  const source = await yauzl.openPromise(file, { lazyEntries: true });
  try {
    for await (const entry of source.eachEntry()) {
      if (entry.fileName.endsWith(".network")) {
        const contents = await buffer(
          await source.openReadStreamPromise(entry)
        );
        for (const line of contents.toString("utf-8").split("\n")) {
          if (line.trim().length > 0) {
            collectBodyResources(decodeJson(line), resources, sockets);
          }
        }
      }
    }
  } finally {
    source.close();
  }
  return { resources, sockets };
};

/** Preserve JSON syntax and reuse the existing private-value redactor for metadata. */
const redactEntry = (
  contents: Buffer,
  name: string,
  values: readonly string[],
  bodies: Awaited<ReturnType<typeof bodyResources>>
): Buffer => {
  // WebSocket resources retain frame metadata; all other attached bodies are opaque.
  if (bodies.resources.has(name) && !bodies.sockets.has(name)) {
    return Buffer.from(omittedPayload);
  }
  if (/\.(?:trace|network|stacks|jsonl)$/u.test(name)) {
    return Buffer.from(
      contents
        .toString("utf-8")
        .split("\n")
        .map((line) => {
          if (line.trim().length === 0) {
            return line;
          }
          const value = omitPayloads(decodeJson(line));
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
        const bodies = await bodyResources(file);
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
                    redactEntry(
                      contents,
                      entry.fileName,
                      sensitiveValues,
                      bodies
                    ),
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
