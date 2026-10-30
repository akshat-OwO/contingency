import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { makeIosDiscovery } from "../src/services/ios-discovery.ts";
import { makeIosPreparation } from "../src/services/ios-preparation.ts";
import { iosSimctlHost } from "../src/services/ios-simctl.ts";

// Select a proof-owned, already running simulator. This proof never boots or deletes it.
const udid = process.env.CONTINGENCY_IOS_SELECTED;
const appPath = process.argv.at(2);
assert.ok(
  udid && appPath,
  "Supply CONTINGENCY_IOS_SELECTED and an absolute simulator .app path"
);
const execute = promisify(execFile);
const simctl = async (args: readonly string[]) => {
  const result = await execute("xcrun", ["simctl", ...args], {
    timeout: 180_000,
  });
  return result.stdout.trim();
};
const inventory = async () => {
  const devices = await Effect.runPromise(makeIosDiscovery().devices());
  return devices.map((device) => device.udid).toSorted();
};
const before = await inventory();
const devices = await Effect.runPromise(makeIosDiscovery().devices());
const device = devices.find((entry) => entry.udid === udid);
assert.ok(device);
assert.equal(
  device.state,
  "Booted",
  "Start the proof-owned simulator before this proof"
);
const app = await Effect.runPromise(iosSimctlHost.readApp(appPath));
const input = {
  device,
  environment: {
    build: app.build,
    bundleId: app.bundleId,
    deviceType: device.deviceType,
    runtimeVersion: device.runtimeVersion,
  },
  requiredCapabilities: [],
};
await Effect.runPromise(
  Effect.scoped(makeIosPreparation().prepare({ ...input, appPath }))
);
const container = await simctl([
  "get_app_container",
  udid,
  app.bundleId,
  "data",
]);
const sentinel = path.join(container, "Documents/selected-simulator-proof.txt");
await writeFile(sentinel, "existing selected simulator data");
await Effect.runPromise(Effect.scoped(makeIosPreparation().prepare(input)));
assert.equal(
  await readFile(sentinel, "utf-8"),
  "existing selected simulator data"
);
assert.deepEqual(
  await inventory(),
  before,
  "Product changed the simulator inventory"
);
const remaining = await Effect.runPromise(makeIosDiscovery().devices());
const after = remaining.find((entry) => entry.udid === udid);
assert.equal(
  after?.state,
  "Booted",
  "Closing the session must leave the simulator running"
);
process.stdout.write(
  `PASS: selected=${udid}; existing data retained; simulator inventory unchanged; selected simulator remains running\n`
);
