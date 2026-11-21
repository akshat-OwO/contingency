import path from "node:path";

import { Effect, FileSystem, Schema } from "effect";

import { androidStreamRelease } from "../services/android-stream-contract.ts";

/**
 * Only the stock scrcpy transport, the emulator gRPC stream, and the stream
 * recorder that muxes its packets (ADR 0080) are reachable, with what they
 * import. No dashboard or session recorder.
 */
export const VENDORED_SERVE_EMU_FILES = [
  "control-input-queue.js",
  "device-capabilities.js",
  "emulator-grpc.js",
  "exec.js",
  "grpc-mmap.js",
  "grpc-recording-encoder.js",
  "grpc-session.js",
  "h264-encoder.js",
  "h264-readiness.js",
  "input.js",
  "recording-canvas.js",
  "recording-file-target.js",
  "scrcpy-server.js",
  "scrcpy.js",
  "screen-recording.js",
  "session-status.js",
  "shared/api-contracts.js",
  "shared/control-contracts.js",
  "stream-settings.js",
] as const;

const HubManifest = Schema.Struct({
  version: Schema.Literal(androidStreamRelease.hub),
});

export const vendorDisplayTransport = Effect.fn("vendorDisplayTransport")(
  function* vendorDisplay(sourceRoot: string, outputRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const source = path.join(sourceRoot, "node_modules/expo-device-hub");
    const target = path.join(outputRoot, "node_modules/expo-device-hub");
    const rawManifest = yield* fs.readFileString(
      path.join(source, "package.json")
    );
    yield* Effect.try({
      catch: (cause) =>
        new Error(
          `expo-device-hub version does not match pinned release ${androidStreamRelease.hub}`,
          { cause }
        ),
      try: () => Schema.decodeUnknownSync(HubManifest)(JSON.parse(rawManifest)),
    });
    yield* fs.makeDirectory(path.join(target, "vendor/serve-emu/dist/shared"), {
      recursive: true,
    });
    for (const file of VENDORED_SERVE_EMU_FILES) {
      yield* fs.copyFile(
        path.join(source, "vendor/serve-emu/dist", file),
        path.join(target, "vendor/serve-emu/dist", file)
      );
    }
    yield* fs.copyFile(
      path.join(source, "LICENSE"),
      path.join(target, "LICENSE")
    );
    yield* fs.copyFile(
      path.join(source, "vendor/serve-emu/LICENSE"),
      path.join(target, "vendor/serve-emu/LICENSE")
    );
    yield* fs.writeFileString(
      path.join(target, "package.json"),
      JSON.stringify({
        name: "expo-device-hub",
        type: "module",
        version: androidStreamRelease.hub,
      })
    );
    yield* fs.copy(
      path.join(sourceRoot, "android/stream"),
      path.join(outputRoot, "android/stream")
    );
  }
);
