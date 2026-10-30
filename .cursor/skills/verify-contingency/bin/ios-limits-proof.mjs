/* oxlint-disable eslint/no-await-in-loop -- Each probe owns one live selected simulator and closes it before the next. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import {
  selectedSimulatorResource,
  simulatorInventory,
} from "./ios-proof-resources.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
const selected = process.env.CONTINGENCY_IOS_SELECTED;
assert.ok(directory && appPath && selected);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const execute = promisify(execFile);
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/ios-workspace-runs"
);
const receipt = { blockers: [], limits: {}, resources: [] };
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-limits-${process.pid}-${sequence}`;
};
const call = (command, source = "agent") =>
  iosRpc(instance.mcpUrl, "ios.workspace.command", { command, source });
const read = (sessionId) => call({ _tag: "read", sessionId });
const observe = (sessionId) =>
  call({ _tag: "observe", image: false, sessionId });
const control = async (...args) => {
  const result = await execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  return result.stdout;
};
const click = (name) => control("browser", "ios-click", "--name", name);
const screenshot = async (name) => {
  await control(
    "browser",
    "snapshot",
    "--aria",
    "--path",
    path.join(artifacts, `${name}.aria.txt`)
  );
  await control(
    "browser",
    "screenshot",
    "--path",
    path.join(artifacts, `${name}.png`)
  );
};
const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
const device = devices.find((entry) => entry.udid === selected);
assert.ok(device);
const selection = {
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
};
const sessions = [];
const start = async (kind = "run") => {
  const session = await call(
    {
      _tag: "start",
      flowSkillName: "ios-login",
      kind,
      operationId: operation(),
      recordingId: null,
      selection,
    },
    kind === "teaching" ? "user" : "agent"
  );
  sessions.push(session.id);
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?ios=${session.id}`
  );
  await click("Allow");
  await click("Prepare selected simulator");
  return session.id;
};
const refusal = async (command, pattern = /capability_missing/u) => {
  let message;
  try {
    await call(command);
  } catch (error) {
    message = String(error);
  }
  assert.ok(message, "Expected an explicit refusal");
  assert.match(message, pattern);
  return message;
};
const ownResource = async () => {
  const resource = await selectedSimulatorResource(instance, selected);
  receipt.resources.push(resource);
  return resource;
};
const inventoryBefore = await simulatorInventory(selected);

try {
  const publicSessions = await control(
    "mcp",
    "call",
    "--tool",
    "agent_device_sessions_list",
    "--params",
    '{"platform":"ios"}'
  );
  assert.ok(Array.isArray(JSON.parse(publicSessions)));
  receipt.limits.publicMcpListing = true;

  const inputSession = await start();
  await ownResource();
  receipt.limits.oneBinding = await refusal(
    {
      _tag: "start",
      flowSkillName: "ios-login",
      kind: "run",
      operationId: operation(),
      recordingId: null,
      selection,
    },
    /already bound/u
  );
  const access = await iosRpc(instance.mcpUrl, "ios.stream.access", {
    sessionId: inputSession,
  });
  const streamUrl = new URL(access.path, instance.mcpUrl);
  const denied = async (name, url, options, status) => {
    // oxlint-disable-next-line promise/avoid-new -- Check the actual HTTP response event, including a literal Host header.
    const actual = await new Promise((resolve, reject) => {
      const connection = request(url, options, (response) => {
        resolve(response.statusCode);
        response.destroy();
        connection.destroy();
      });
      connection.once("error", reject);
      connection.setTimeout(30_000, () =>
        connection.destroy(new Error("Stream boundary probe hung"))
      );
      connection.end();
    });
    assert.equal(actual, status);
    receipt.limits[name] = actual;
  };
  await denied("missingStreamCredential", streamUrl, {}, 401);
  await denied(
    "wrongStreamCredential",
    streamUrl,
    { headers: { authorization: "Bearer incorrect" } },
    401
  );
  const authorized = { authorization: `Bearer ${access.token}` };
  await denied(
    "foreignHost",
    streamUrl,
    { headers: { ...authorized, host: "foreign.invalid" } },
    403
  );
  await denied(
    "foreignOrigin",
    streamUrl,
    { headers: { ...authorized, origin: "https://example.invalid" } },
    403
  );
  await denied(
    "deviceOverride",
    `${streamUrl}?device=foreign`,
    { headers: authorized },
    404
  );
  await denied(
    "streamInputRoute",
    `${streamUrl}/input`,
    { headers: authorized },
    404
  );
  await denied(
    "streamPost",
    streamUrl,
    { headers: authorized, method: "POST" },
    404
  );
  await denied(
    "streamUpgrade",
    streamUrl,
    {
      headers: { ...authorized, connection: "Upgrade", upgrade: "websocket" },
    },
    404
  );
  await click("Take control");
  const beforeSwipe = await read(inputSession);
  receipt.limits.edgeSwipe = JSON.parse(await control("browser", "ios-swipe"));
  let current = await read(inputSession);
  assert.equal(current.observation.id, beforeSwipe.observation.id);
  const field = current.observation.nodes.find(
    (node) => node.role === "text-field"
  );
  assert.ok(field);
  receipt.limits.takeover = await refusal(
    {
      _tag: "input",
      action: { _tag: "fill", target: field.target, text: "not forwarded" },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: inputSession,
    },
    /Only the current controller/u
  );
  await click("Return control");
  current = await observe(inputSession);
  receipt.limits.coordinates = await refusal(
    {
      _tag: "input",
      action: { _tag: "coordinate", x: 1, y: 2 },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: inputSession,
    },
    /./u
  );
  receipt.limits.back = await refusal({
    _tag: "input",
    action: { _tag: "back" },
    observationId: current.observation.id,
    operationId: operation(),
    sessionId: inputSession,
  });
  await screenshot("limit-back");
  await click("Recover selected simulator");
  await call(
    { _tag: "close", operationId: operation(), sessionId: inputSession },
    "user"
  );
  await denied(
    "revokedStreamCredential",
    streamUrl,
    { headers: authorized },
    401
  );
  const lossSession = await start("teaching");
  const lossResource = await ownResource();
  await click("Start recording");
  const processes = await execute("ps", ["-axo", "pid=,ppid=,command="]);
  const helpers = processes.stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes("/dist/ios/framebuffer/framebuffer ") &&
        line.includes(lossResource.udid)
    );
  assert.equal(
    helpers.length,
    1,
    "Signal only this proof's exact framebuffer helper"
  );
  const helper = Number(helpers[0].trim().split(/\s+/u)[0]);
  receipt.resources.push({
    owner: lossResource.owner,
    pid: helper,
    role: "framebuffer",
    stop: "SIGKILL fault injection; scoped reap",
  });
  process.kill(helper, "SIGKILL");
  await control(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Recover selected simulator",
    "--timeout-ms",
    "30000"
  );
  const lost = await read(lossSession);
  assert.equal(lost.phase, "paused");
  assert.equal(lost.captureState._tag, "failed");
  receipt.limits.midRecordingLoss = true;
  await screenshot("limit-stream-loss");
  await click("Recover selected simulator");
  const recovered = await read(lossSession);
  assert.equal(recovered.phase, "running");
  assert.equal(recovered.captureState._tag, "failed");
  const recoveredResource = await ownResource();
  assert.equal(recoveredResource.udid, lossResource.udid);
  await control(
    "browser",
    "wait",
    "--text",
    "iOS mirror paused. No input is sent until transport is restored.",
    "--state",
    "hidden",
    "--timeout-ms",
    "30000"
  );
  receipt.limits.sameSimulatorRecovery = true;
  await screenshot("stream-recovered");
  await call(
    { _tag: "close", operationId: operation(), sessionId: lossSession },
    "user"
  );
  process.stdout.write("iOS live refusals, transport loss, recovery passed\n");
} catch (error) {
  await screenshot("limit-blocked").catch((captureError) =>
    receipt.blockers.push(`Evidence capture: ${captureError}`)
  );
  receipt.blockers.push(String(error));
  throw error;
} finally {
  for (const sessionId of sessions) {
    const current = await read(sessionId).catch(() => null);
    if (
      current &&
      !["closed", "completed", "refused"].includes(current.phase)
    ) {
      await call(
        { _tag: "close", operationId: operation(), sessionId },
        "user"
      ).catch((error) => receipt.blockers.push(`Cleanup: ${error}`));
    }
  }
  receipt.simulatorInventory = {
    after: await simulatorInventory(selected),
    before: inventoryBefore,
    excludedProofOwned: selected,
  };
  assert.deepEqual(receipt.simulatorInventory.after, inventoryBefore);
  await writeFile(
    path.join(artifacts, "limits.json"),
    JSON.stringify(receipt, null, 2)
  );
}
