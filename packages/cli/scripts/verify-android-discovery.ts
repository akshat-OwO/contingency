import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ContingencyRpcs } from "@contingency/protocol";
import { NodeRuntime } from "@effect/platform-node";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import type { AndroidDeviceSelection } from "../src/services/android-runtime-contract.ts";

const execute = promisify(execFile);
const adb = async (serial: string, ...args: string[]) => {
  const { stdout } = await execute("adb", ["-s", serial, ...args]);
  return stdout.trim();
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const state = async (serial: string) => {
  const windows = await adb(serial, "shell", "dumpsys", "window");
  return {
    foreground: digest(
      windows
        .split("\n")
        .filter((line) => line.includes("mCurrentFocus"))
        .join("\n")
    ),
    forwards: digest(await adb(serial, "forward", "--list")),
    packages: digest(
      await adb(serial, "shell", "pm", "list", "packages", "--user", "0")
    ),
  };
};

const program = Effect.scoped(
  Effect.gen(function* verifyDiscovery() {
    const url = process.env.CONTINGENCY_ANDROID_RPC_URL;
    const directory = process.env.CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY;
    const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
    if (!url || !directory || !serial) {
      throw new Error(
        "Supply the isolated Workspace websocket URL, authorized serial and evidence directory."
      );
    }
    const read = (...args: string[]) =>
      Effect.promise(() => adb(serial, ...args));
    const common = {
      api: 36 as const,
      fingerprint: yield* read("shell", "getprop", "ro.build.fingerprint"),
      host: "local" as const,
      serial,
    };
    const device: AndroidDeviceSelection = process.env.CONTINGENCY_ANDROID_MODEL
      ? {
          ...common,
          kind: "physical",
          model: process.env.CONTINGENCY_ANDROID_MODEL,
        }
      : {
          ...common,
          avd: yield* read("emu", "avd", "name").pipe(
            Effect.map((name) => name.split(/\r?\n/u)[0] ?? "")
          ),
          kind: "emulator",
        };
    const client = yield* RpcClient.make(ContingencyRpcs, { flatten: true });
    const temporaryBefore = yield* Effect.promise(() =>
      readdir(tmpdir()).then((entries) =>
        entries
          .filter((entry) => entry.startsWith("contingency-discovery-"))
          .toSorted()
      )
    );
    const before = yield* Effect.promise(() => state(serial));
    const devices = yield* client("android.devices.list", {});
    assert.ok(
      devices.some(
        (entry) =>
          entry.serial === serial &&
          entry.api === 36 &&
          entry.state === "device"
      )
    );
    const apps = yield* client("android.apps.list", { device });
    assert.ok(apps.length > 0);
    assert.ok(
      apps.every(
        (app) =>
          app.package && app.label && app.versionCode && app.launchActivity
      )
    );
    const expectedPackage = process.env.CONTINGENCY_ANDROID_EXPECTED_APP;
    const expectedApp = apps.find((app) => app.package === expectedPackage);
    if (expectedPackage) {
      assert.ok(expectedApp);
      assert.equal(
        expectedApp.label,
        process.env.CONTINGENCY_ANDROID_EXPECTED_APP_LABEL
      );
    }
    const refusal = yield* Effect.flip(
      client("android.apps.list", {
        device: { ...device, fingerprint: "deliberately-mismatched" },
      })
    );
    const after = yield* Effect.promise(() => state(serial));
    assert.deepEqual(after, before);
    const temporaryAfter = yield* Effect.promise(() =>
      readdir(tmpdir()).then((entries) =>
        entries
          .filter((entry) => entry.startsWith("contingency-discovery-"))
          .toSorted()
      )
    );
    assert.deepEqual(temporaryAfter, temporaryBefore);
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    const receipt = {
      appCount: apps.length,
      command:
        "android.devices.list; android.apps.list; android.apps.list with mismatched identity",
      deviceKind: device.kind,
      devices: devices.map(({ api, kind, state: runningState }) => ({
        api,
        kind,
        state: runningState,
      })),
      entryPoint: "Workspace RPC /ws",
      expectedApp: expectedApp ?? null,
      feature: "android-discovery",
      refusalTag: refusal._tag,
      sample:
        apps.find((app) => app.package === "com.android.settings") ?? apps[0],
      temporaryArchivesRemoved: true,
      unauthorizedRefused: true,
      unchanged: after,
    };
    yield* Effect.promise(() =>
      writeFile(
        path.join(directory, "discovery-receipt.json"),
        JSON.stringify(receipt, null, 2)
      )
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  })
);
const url = process.env.CONTINGENCY_ANDROID_RPC_URL ?? "ws://127.0.0.1:1/ws";
const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(url).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (address) =>
            new NodeWS.WebSocket(address, {
              headers: {
                Origin: address.replace(/^ws/u, "http").replace(/\/ws$/u, ""),
              },
            })
        )
      )
    )
  ),
  Layer.provide(RpcSerialization.layerJson)
);
NodeRuntime.runMain(program.pipe(Effect.provide(protocol)));
