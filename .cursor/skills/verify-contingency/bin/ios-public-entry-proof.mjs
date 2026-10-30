/* oxlint-disable eslint/no-await-in-loop -- One selected simulator journey runs sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { simulatorInventory } from "./ios-proof-resources.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

// A bounded post-listing journey supplements a complete pre-listing receipt.
// It does not replace Teaching, learning, Dry Run, or verification evidence.
const execute = promisify(execFile);
const selected = process.env.CONTINGENCY_IOS_SELECTED;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(selected && appPath && directory);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const artifacts = path.resolve(process.env.CONTINGENCY_IOS_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true });
const receipt = {
  blockers: [],
  coverage: {},
  entry: "public",
  mode: "public-entry",
  startedAt: new Date().toISOString(),
};
const control = async (...args) => {
  const result = await execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  return result.stdout;
};
const tool = async (name, params) =>
  JSON.parse(
    await control(
      "mcp",
      "call",
      "--tool",
      name,
      "--params",
      JSON.stringify(params)
    )
  );
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-public-${process.pid}-${sequence}`;
};
const call = (command) =>
  tool("agent_device_workspace", { command, platform: "ios" });
let sessionId;
const observe = () => call({ _tag: "observe", image: false, sessionId });
const node = (current, role, name) => {
  const found = current.observation.nodes.filter(
    (entry) => entry.role === role && entry.name === name && !entry.covered
  );
  assert.equal(found.length, 1, `Expected one ${role} ${name}`);
  return found[0];
};
const action = async (role, name, text) => {
  const before = await observe();
  const { target } = node(before, role, name);
  return call({
    _tag: "input",
    action:
      text === undefined
        ? { _tag: "activate", target }
        : { _tag: "fill", target, text },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
};
const inventoryBefore = await simulatorInventory();
try {
  assert.equal(process.env.CONTINGENCY_IOS_WORKSPACE_INTERNAL, undefined);
  const listed = await tool("agent_device_sessions_list", { platform: "ios" });
  assert.ok(Array.isArray(listed));
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const discovered = devices.find((entry) => entry.udid === selected);
  assert.ok(discovered);
  const { state: _state, ...device } = discovered;
  receipt.cell = {
    deviceType: device.deviceType,
    runtimeVersion: device.runtimeVersion,
  };
  const started = await call({
    _tag: "start",
    agentSetup: true,
    flowSkillName: "ios-public-entry",
    kind: "teaching",
    operationId: operation(),
    recordingId: null,
    selection: {
      appPath,
      device,
      environment: {
        build: "1",
        bundleId: "dev.contingency.ioslogin",
        deviceType: device.deviceType,
        runtimeVersion: device.runtimeVersion,
      },
      outcomes: [{ name: "Signed in as Test Shopper", role: "text" }],
      setup: {
        conditions: [{ name: "Login fixture", role: "text" }],
        kind: "restart-app",
      },
    },
  });
  sessionId = started.id;
  receipt.coverage.publicStart = true;
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?ios=${sessionId}`
  );
  for (const name of ["Allow", "Prepare selected simulator"]) {
    await control("browser", "ios-click", "--name", name);
  }
  await action("text-field", "Login name", "Test Shopper");
  const requested = await call({
    _tag: "variable-request",
    name: "PASSWORD",
    operationId: operation(),
    purpose: "Test account password",
    replace: false,
    sessionId,
  });
  const variable = requested.variables.find(
    (entry) => entry.name === "PASSWORD"
  );
  assert.ok(variable);
  await iosRpc(instance.mcpUrl, "ios.workspace.command", {
    command: {
      _tag: "variable-supply",
      name: "PASSWORD",
      operationId: operation(),
      requestId: variable.requestId,
      sessionId,
      value: "fixture-password",
    },
    source: "user",
  });
  const before = await observe();
  await call({
    _tag: "input",
    action: {
      _tag: "variable",
      name: "PASSWORD",
      target: node(before, "secure-text-field", "Password").target,
    },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
  await action("button", "Sign in privately");
  let current = await action("button", "Open account");
  node(current, "text", "Account details");
  current = await action("button", "Return to account");
  node(current, "text", "Signed in as Test Shopper");
  receipt.coverage.journey = [
    "fill",
    "variable",
    "activate",
    "activate",
    "activate",
  ];
  const retained = await tool("agent_device_sessions_list", {
    platform: "ios",
  });
  receipt.coverage.publicListing = retained.some(
    (entry) => entry.id === sessionId
  );
  assert.equal(receipt.coverage.publicListing, true);
  await control(
    "browser",
    "snapshot",
    "--aria",
    "--path",
    path.join(artifacts, "public-outcome.aria.txt")
  );
  await control(
    "browser",
    "screenshot",
    "--path",
    path.join(artifacts, "public-outcome.png")
  );
} catch (error) {
  receipt.blockers.push(String(error));
  throw error;
} finally {
  if (sessionId) {
    await call({ _tag: "close", operationId: operation(), sessionId });
  }
  const after = await simulatorInventory();
  assert.deepEqual(after, inventoryBefore);
  assert.equal(
    after.find((device) => device.udid === selected)?.state,
    "Booted"
  );
  receipt.coverage.noSimulatorCreationOrDeletion = true;
  receipt.coverage.selectedSimulatorRemainsRunning = true;
  receipt.completedAt = new Date().toISOString();
  await writeFile(
    path.join(artifacts, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}
