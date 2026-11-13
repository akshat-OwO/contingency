import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { vendorPackages } from "./vendor-packages.ts";

vendorPackages(
  ["playwright-core", "lighthouse", "puppeteer-core", "agent-device"],
  process.cwd(),
  path.resolve("dist")
).pipe(
  Effect.andThen(
    Effect.gen(function* vendorDisplayTransport() {
      const fs = yield* FileSystem.FileSystem;
      const source = path.resolve("node_modules/expo-device-hub");
      const target = path.resolve("dist/node_modules/expo-device-hub");
      yield* fs.makeDirectory(
        path.join(target, "vendor/serve-emu/dist/shared"),
        { recursive: true }
      );
      // Only the stock scrcpy transport and the emulator gRPC stream are
      // reachable, with what they import. No dashboard or recorder.
      for (const file of [
        "control-input-queue.js",
        "device-capabilities.js",
        "emulator-grpc.js",
        "exec.js",
        "grpc-mmap.js",
        "grpc-session.js",
        "h264-encoder.js",
        "h264-readiness.js",
        "input.js",
        "scrcpy-server.js",
        "scrcpy.js",
        "session-status.js",
        "shared/api-contracts.js",
        "shared/control-contracts.js",
        "stream-settings.js",
      ]) {
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
          version: "0.15.3",
        })
      );
      yield* fs.copy(
        path.resolve("android/stream"),
        path.resolve("dist/android/stream")
      );
    })
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
