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
  architecture: Schema.Literal("universal"),
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

/** Inspect the fat Mach-O and both executable slices without macOS tooling. */
export const isUniversalIosFramebuffer = (bytes: Buffer): boolean => {
  if (
    bytes.length < 48 ||
    bytes.readUInt32BE(0) !== 0xca_fe_ba_be ||
    bytes.readUInt32BE(4) !== 2
  ) {
    return false;
  }
  const architectures = new Set<number>();
  const ranges: { start: number; end: number }[] = [];
  for (const entry of [8, 28]) {
    const cpu = bytes.readUInt32BE(entry);
    const start = bytes.readUInt32BE(entry + 8);
    const size = bytes.readUInt32BE(entry + 12);
    const end = start + size;
    if (
      (cpu !== 0x01_00_00_0c && cpu !== 0x01_00_00_07) ||
      architectures.has(cpu) ||
      start < 48 ||
      size < 32 ||
      end > bytes.length ||
      ranges.some((range) => start < range.end && end > range.start) ||
      bytes.readUInt32LE(start) !== 0xfe_ed_fa_cf ||
      bytes.readUInt32LE(start + 4) !== cpu ||
      bytes.readUInt32LE(start + 12) !== 2
    ) {
      return false;
    }
    architectures.add(cpu);
    ranges.push({ end, start });
  }
  return true;
};

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
    if (
      manifest.platform !== host.platform ||
      (host.architecture !== "arm64" && host.architecture !== "x64")
    ) {
      return yield* Effect.fail(incompatible());
    }
    const bytes = yield* read("framebuffer");
    if (
      !isUniversalIosFramebuffer(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    ) {
      return yield* Effect.fail(incompatible());
    }
    return path.join(directory, "framebuffer");
  });
