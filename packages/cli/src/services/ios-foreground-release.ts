import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";

import type { PlatformRuntimeError } from "./platform-runtime.ts";

const incompatible = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "ownership_unknown",
  message: "Rebuild the Contingency iOS foreground helper for this host.",
});

export const iosForegroundVersion = 1;
export const IosForegroundManifest = Schema.Struct({
  architecture: Schema.Literals(["arm64", "x64"]),
  executable: Schema.Literal("foreground"),
  platform: Schema.Literal("darwin"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  signing: Schema.Literal("ad-hoc"),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  version: Schema.Literal(iosForegroundVersion),
});

export const resolveIosForegroundRelease = (moduleDirectory: string) =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "ios/foreground")
    : path.resolve(moduleDirectory, "../../dist/ios/foreground");

const currentHost = { architecture: process.arch, platform: process.platform };

/** Never execute an unverified binary or resolve a manifest-supplied path. */
export const verifyIosForegroundRelease = (
  directory = resolveIosForegroundRelease(import.meta.dirname),
  host: {
    readonly platform: string;
    readonly architecture: string;
  } = currentHost
) =>
  Effect.gen(function* verifyForeground() {
    const read = (name: string) =>
      Effect.tryPromise({
        catch: () => incompatible(),
        try: () => readFile(path.join(directory, name)),
      });
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(IosForegroundManifest)
    )((yield* read("manifest.json")).toString("utf-8")).pipe(
      Effect.mapError(() => incompatible())
    );
    if (
      manifest.platform !== host.platform ||
      manifest.architecture !== host.architecture
    ) {
      return yield* Effect.fail(incompatible());
    }
    const bytes = yield* read("foreground");
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
      return yield* Effect.fail(incompatible());
    }
    return path.join(directory, "foreground");
  });
