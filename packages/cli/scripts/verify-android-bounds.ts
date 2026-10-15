import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AndroidWorkspaceObservation } from "@contingency/protocol";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema, Scope } from "effect";

import { androidHelperRelease } from "../src/services/android-runtime-contract.ts";
import type { AndroidDeviceSelection } from "../src/services/android-runtime-contract.ts";
import { makeAndroidRuntimeFactory } from "../src/services/android-runtime.ts";

const execute = promisify(execFile);
Effect.scoped(
  Effect.gen(function* verifyBounds() {
    const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
    const targetApp = process.env.CONTINGENCY_ANDROID_TARGET_APP;
    const directory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
    const model = process.env.CONTINGENCY_ANDROID_MODEL;
    if (!serial || !targetApp || !directory) {
      throw new Error(
        "Supply the authorized serial, current Target App and evidence directory."
      );
    }
    const read = (...args: string[]) =>
      Effect.tryPromise(() => execute("adb", ["-s", serial, ...args])).pipe(
        Effect.map(({ stdout }) => stdout.trim())
      );
    const fingerprint = yield* read("shell", "getprop", "ro.build.fingerprint");
    const device: AndroidDeviceSelection = model
      ? { api: 36, fingerprint, host: "local", kind: "physical", model, serial }
      : {
          api: 36,
          avd: (yield* read("emu", "avd", "name")).split(/\r?\n/u)[0] ?? "",
          fingerprint,
          host: "local",
          kind: "emulator",
          serial,
        };
    const scope = yield* Scope.Scope;
    const runtime = yield* makeAndroidRuntimeFactory().start({
      device,
      installationGrant:
        process.env.CONTINGENCY_ANDROID_HELPER_GRANT === "install" && !model
          ? {
              operation: "install",
              serial,
              sha256: androidHelperRelease.sha256,
            }
          : undefined,
      platform: "android",
      requiredCapabilities: ["semantic-actions", "screenshots"],
      scope,
      targetApp,
    });
    yield* Effect.addFinalizer(() => runtime.close().pipe(Effect.orDie));
    const observation = yield* runtime.observe();
    const pixels = Buffer.from(observation.screenshot.image, "base64");
    const frame = yield* Schema.decodeUnknownEffect(
      AndroidWorkspaceObservation
    )({
      capturedAt: observation.screenshot.capturedAt,
      height: pixels.readUInt32BE(20),
      id: observation.id,
      image: null,
      nodes: observation.nodes,
      width: pixels.readUInt32BE(16),
    });
    const bounded = frame.nodes.filter(
      (node) =>
        node.bounds !== undefined &&
        node.bounds.width > 0 &&
        node.bounds.height > 0
    );
    assert.ok(bounded.length > 0);
    assert.ok(
      bounded.some(
        ({ bounds }) =>
          bounds &&
          bounds.x < frame.width &&
          bounds.y < frame.height &&
          bounds.x + bounds.width > 0 &&
          bounds.y + bounds.height > 0
      )
    );
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    const screenshot = process.env.CONTINGENCY_ANDROID_INSPECTION_IMAGE;
    if (screenshot) {
      yield* Effect.promise(() =>
        writeFile(screenshot, pixels, { mode: 0o600 })
      );
    }
    const receipt = {
      boundedCount: bounded.length,
      deviceKind: device.kind,
      entryPoint:
        "production Android runtime factory and Workspace observation codec",
      feature: "android-element-bounds",
      height: frame.height,
      nodeCount: frame.nodes.length,
      observationId: frame.id,
      sample: bounded.slice(0, 8).map(({ bounds, role }) => ({ bounds, role })),
      width: frame.width,
    };
    yield* Effect.promise(() =>
      writeFile(
        path.join(directory, "bounds-receipt.json"),
        JSON.stringify(receipt, null, 2)
      )
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  })
).pipe(NodeRuntime.runMain);
