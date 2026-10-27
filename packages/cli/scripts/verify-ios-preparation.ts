import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";

import type { IosPreparationInput } from "../src/services/ios-contract.ts";
import {
  IosDeviceSchema,
  IosEnvironmentSchema,
  iosError,
  iosUuid,
} from "../src/services/ios-contract.ts";
import { makeIosDiscovery } from "../src/services/ios-discovery.ts";
import { makeIosPreparation } from "../src/services/ios-preparation.ts";
import { makeIosSessionResources } from "../src/services/ios-session-resources.ts";
import { iosSimctlHost } from "../src/services/ios-simctl.ts";

const execute = promisify(execFile);
const simctl = async (args: readonly string[]) => {
  const result = await execute("xcrun", ["simctl", ...args], {
    timeout: 180_000,
  });
  return result.stdout.trim();
};
const io = {
  ...iosSimctlHost,
  device: (args: readonly string[]) =>
    Effect.gen(function* guardBoot() {
      if (args[0] === "boot") {
        const booted = yield* Effect.promise(() =>
          simctl(["list", "devices", "booted", "--json"])
        );
        assert.equal(
          Object.values(JSON.parse(booted).devices).flat().length,
          0,
          "Another simulator is booted; do not boot this clone"
        );
      }
      return yield* iosSimctlHost.device(args);
    }),
};
const digestTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  const entries = await readdir(root, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return `${entry.name}:${await digestTree(file)}`;
        }
        if (entry.isFile()) {
          return `${entry.name}:${createHash("sha256")
            .update(await readFile(file))
            .digest("hex")}`;
        }
        return entry.name;
      })
  );
  for (const entry of children) {
    hash.update(entry);
  }
  return hash.digest("hex");
};
const workerInput = process.env.CONTINGENCY_IOS_PROOF_INPUT;
if (workerInput === undefined) {
  const fixture = process.argv.at(2);
  assert.ok(fixture, "Supply a simulator .app path");
  assert.ok(
    fixture?.endsWith(".app"),
    "Supply an absolute simulator .app path"
  );
  const memoryResult = await execute("memory_pressure", ["-Q"]);
  const swapResult = await execute("sysctl", ["vm.swapusage"]);
  const memory = memoryResult.stdout.trim();
  const swap = swapResult.stdout.trim();
  process.stdout.write(`${memory}\n${swap}\n`);
  assert.equal(
    Object.values(
      JSON.parse(await simctl(["list", "devices", "booted", "--json"])).devices
    ).flat().length,
    0,
    "Skip proof: another simulator is already booted"
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), "contingency-ios-proof-")
  );
  const records = path.join(directory, "records");
  let template: string | undefined;
  let child: ReturnType<typeof fork> | undefined;
  try {
    template = await simctl([
      "create",
      "Contingency issue 547 proof",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    ]);
    process.stdout.write(
      `template=${template}, owner=${process.pid}, started=${new Date().toISOString()}\n`
    );
    await Effect.runPromise(io.device(["boot", template]));
    await simctl(["bootstatus", template, "-b"]);
    const app = await Effect.runPromise(io.readApp(fixture));
    await simctl(["install", template, fixture]);
    await simctl(["privacy", template, "grant", "camera", app.bundleId]);
    const container = await simctl([
      "get_app_container",
      template,
      app.bundleId,
      "data",
    ]);
    await writeFile(
      path.join(container, "Documents/template-only.txt"),
      "Template data must never reach a session"
    );
    await simctl(["shutdown", template]);
    const devices = await Effect.runPromise(makeIosDiscovery(io).devices());
    const device = devices.find((entry) => entry.udid === template);
    assert.ok(device);
    const input: IosPreparationInput = {
      device,
      environment: {
        build: app.build,
        bundleId: app.bundleId,
        deviceType: device.deviceType,
        runtimeVersion: device.runtimeVersion,
      },
      requiredCapabilities: [],
    };
    const selected = await Effect.runPromise(
      makeIosDiscovery(io).resolve(device)
    );
    const before = await digestTree(selected.dataPath);
    const resources = makeIosSessionResources(records, io);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* normalSession() {
          const session = yield* makeIosPreparation(io, resources).prepare(
            input
          );
          const data = yield* io.device([
            "get_app_container",
            session.device.udid,
            app.bundleId,
            "data",
          ]);
          const entries = yield* Effect.promise(() =>
            readdir(path.join(data, "Documents"))
          );
          assert.equal(entries.includes("template-only.txt"), false);
          process.stdout.write(
            `normal clone=${session.device.udid}, fresh app data verified\n`
          );
        })
      )
    );
    assert.equal(
      await digestTree(selected.dataPath),
      before,
      "Selected simulator changed after success"
    );
    assert.deepEqual(await readdir(records), []);
    const failed = await Effect.runPromise(
      Effect.scoped(
        makeIosPreparation(io, resources, () =>
          Effect.fail(iosError("preparation_failed"))
        ).prepare({ ...input, appPath: fixture })
      ).pipe(Effect.result)
    );
    assert.equal(failed._tag, "Failure");
    assert.equal(
      await digestTree(selected.dataPath),
      before,
      "Selected simulator changed after failure"
    );
    assert.deepEqual(await readdir(records), []);
    child = fork(import.meta.filename, [], {
      env: {
        ...process.env,
        CONTINGENCY_IOS_PROOF_INPUT: JSON.stringify(input),
        CONTINGENCY_IOS_PROOF_RECORDS: records,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const [rawMessage] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Session owner exited before readiness");
      }),
    ]);
    const message = Schema.decodeUnknownSync(
      Schema.Struct({ ready: Schema.String.check(Schema.isPattern(iosUuid)) })
    )(rawMessage);
    process.stdout.write(
      `SIGKILL owner=${child.pid}, clone=${message.ready}\n`
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await Effect.runPromise(makeIosSessionResources(records, io).cleanup());
    assert.deepEqual(await readdir(records), []);
    assert.equal(
      await digestTree(selected.dataPath),
      before,
      "Selected simulator changed after SIGKILL"
    );
    const inventory = await simctl(["list", "devices", "--json"]);
    assert.equal(inventory.includes(message.ready), false);
    process.stdout.write(
      `PASS: template hash ${before} unchanged after success, failure and SIGKILL; startup reclaimed only the recorded clone\n`
    );
  } finally {
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await Effect.runPromise(makeIosSessionResources(records, io).cleanup());
    if (template !== undefined) {
      await simctl(["delete", template]);
    }
    await rm(directory, { force: true, recursive: true });
    process.stdout.write(
      "Cleanup: owned child exited, recorded clones and template deleted, temporary state removed\n"
    );
  }
} else {
  const decoded = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        device: IosDeviceSchema,
        environment: IosEnvironmentSchema,
      })
    )
  )(workerInput);
  const input: IosPreparationInput = { ...decoded, requiredCapabilities: [] };
  const records = process.env.CONTINGENCY_IOS_PROOF_RECORDS;
  assert.ok(records);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* killedSession() {
        const session = yield* makeIosPreparation(
          io,
          makeIosSessionResources(records, io)
        ).prepare(input);
        process.send?.({ ready: session.device.udid });
        yield* Effect.never;
      })
    )
  );
}
