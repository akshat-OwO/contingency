import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";

import type { PlatformRuntimeError } from "./platform-runtime.ts";

const incompatible = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "helper_incompatible",
  message:
    "Reinstall the Contingency CLI with its packaged iOS framebuffer helper.",
});

export const iosFramebufferVersion = 2;
export const IosFramebufferManifest = Schema.Struct({
  architecture: Schema.Literal("arm64"),
  executable: Schema.Literal("framebuffer"),
  platform: Schema.Literal("darwin"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  signing: Schema.Literal("ad-hoc"),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  version: Schema.Literal(iosFramebufferVersion),
});

export const resolveIosFramebufferRelease = (moduleDirectory: string) =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "ios/framebuffer")
    : path.resolve(moduleDirectory, "../../dist/ios/framebuffer");

/** Accept exactly one thin arm64 Mach-O executable, refusing fat containers. */
export const isArm64IosFramebuffer = (bytes: Buffer): boolean =>
  bytes.length >= 32 &&
  bytes.readUInt32LE(0) === 0xfe_ed_fa_cf &&
  bytes.readUInt32LE(4) === 0x01_00_00_0c &&
  bytes.readUInt32LE(12) === 2;

const currentHost = { architecture: process.arch, platform: process.platform };

/** Pin to the packed manifest, not an Xcode-dependent source-build digest.
 * This detects corruption and replacement of the binary alone. npm provenance
 * authenticates the package; the adjacent manifest is not a trust root.
 * Never resolve a manifest-supplied path. */
export const verifyIosFramebufferRelease = (
  directory = resolveIosFramebufferRelease(import.meta.dirname),
  host: {
    readonly platform: string;
    readonly architecture: string;
  } = currentHost
) =>
  Effect.gen(function* verifyFramebuffer() {
    const read = (name: string) =>
      Effect.tryPromise({
        catch: () => incompatible(),
        try: () => readFile(path.join(directory, name)),
      });
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(IosFramebufferManifest)
    )((yield* read("manifest.json")).toString("utf-8")).pipe(
      Effect.mapError(() => incompatible())
    );
    if (manifest.platform !== host.platform || host.architecture !== "arm64") {
      return yield* Effect.fail(incompatible());
    }
    const bytes = yield* read("framebuffer");
    if (
      !isArm64IosFramebuffer(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    ) {
      return yield* Effect.fail(incompatible());
    }
    return path.join(directory, "framebuffer");
  });
