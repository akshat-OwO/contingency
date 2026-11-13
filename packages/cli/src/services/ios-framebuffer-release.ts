import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";

import type { PlatformRuntimeError } from "./platform-runtime.ts";

const incompatible = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "helper_incompatible",
  message: "Reinstall the Contingency CLI with its packaged iOS helpers.",
});

export const iosFramebufferVersion = 2;
export const iosHidVersion = 1;
export const IosFramebufferManifest = Schema.Struct({
  architecture: Schema.Literal("arm64"),
  executable: Schema.Literal("framebuffer"),
  platform: Schema.Literal("darwin"),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  signing: Schema.Literal("ad-hoc"),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  version: Schema.Literal(iosFramebufferVersion),
});

/** The packaged Forwarded Input helper, built and pinned like the framebuffer helper. */
export const IosHidManifest = Schema.Struct({
  ...IosFramebufferManifest.fields,
  executable: Schema.Literal("hid"),
  version: Schema.Literal(iosHidVersion),
});

const resolveIosHelper = (moduleDirectory: string, name: string) =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "ios", name)
    : path.resolve(moduleDirectory, "../../dist/ios", name);
export const resolveIosFramebufferRelease = (moduleDirectory: string) =>
  resolveIosHelper(moduleDirectory, "framebuffer");
export const resolveIosHidRelease = (moduleDirectory: string) =>
  resolveIosHelper(moduleDirectory, "hid");

/** Accept exactly one thin arm64 Mach-O executable, refusing fat containers. */
export const isArm64IosFramebuffer = (bytes: Buffer): boolean =>
  bytes.length >= 32 &&
  bytes.readUInt32LE(0) === 0xfe_ed_fa_cf &&
  bytes.readUInt32LE(4) === 0x01_00_00_0c &&
  bytes.readUInt32LE(12) === 2;

const currentHost = { architecture: process.arch, platform: process.platform };

const verifyIosHelper = (
  manifestSchema: typeof IosFramebufferManifest | typeof IosHidManifest,
  executable: "framebuffer" | "hid",
  directory: string,
  host: { readonly platform: string; readonly architecture: string }
) =>
  Effect.gen(function* verifyHelper() {
    const read = (name: string) =>
      Effect.tryPromise({
        catch: () => incompatible(),
        try: () => readFile(path.join(directory, name)),
      });
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(manifestSchema)
    )((yield* read("manifest.json")).toString("utf-8")).pipe(
      Effect.mapError(() => incompatible())
    );
    if (manifest.platform !== host.platform || host.architecture !== "arm64") {
      return yield* Effect.fail(incompatible());
    }
    const bytes = yield* read(executable);
    if (
      !isArm64IosFramebuffer(bytes) ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
    ) {
      return yield* Effect.fail(incompatible());
    }
    return path.join(directory, executable);
  });

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
) => verifyIosHelper(IosFramebufferManifest, "framebuffer", directory, host);

/** The packaged Forwarded Input helper, verified as the framebuffer helper is. */
export const verifyIosHidRelease = (
  directory = resolveIosHidRelease(import.meta.dirname),
  host: {
    readonly platform: string;
    readonly architecture: string;
  } = currentHost
) => verifyIosHelper(IosHidManifest, "hid", directory, host);
