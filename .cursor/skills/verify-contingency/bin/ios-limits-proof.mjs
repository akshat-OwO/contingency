/* oxlint-disable eslint/no-await-in-loop -- Each probe owns one live Session Simulator and closes it before the next. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { iosRpc } from "./ios-workspace-rpc.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
const template = process.env.CONTINGENCY_IOS_TEMPLATE;
assert.ok(directory && appPath && template);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const { createAgentDeviceClient } = await import(
  pathToFileURL(
    path.join(root, "packages/cli/node_modules/agent-device/dist/src/index.js")
  ).href
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
const device = devices.find((entry) => entry.udid === template);
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
  outcomes: [{ name: "Signed in as Public Shopper", role: "text" }],
  setup: {
    conditions: [{ name: "Public login fixture", role: "text" }],
    kind: "fresh-install",
  },
};
const sessions = [];
const start = async (kind = "run") => {
  const session = await call(
    {
      _tag: "start",
      flowSkillName: "ios-public-login",
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
  await click("Prepare Session Simulator");
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
  const processes = await execute("ps", ["-axo", "pid=,ppid="]);
  const parents = new Map(
    processes.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number))
  );
  for (const file of await readdir(
    path.join(homedir(), ".contingency/ios-session-simulators")
  )) {
    const record = JSON.parse(
      await readFile(
        path.join(homedir(), ".contingency/ios-session-simulators", file),
        "utf-8"
      )
    );
    let pid = record.owner;
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === instance.mcpPid) {
        const descendants = [...parents]
          .filter(([candidate]) => {
            let current = candidate;
            const visited = new Set();
            while (current && !visited.has(current)) {
              if (current === record.owner) {
                return true;
              }
              visited.add(current);
              current = parents.get(current);
            }
            return false;
          })
          .map(([descendantPid, parent]) => ({ parent, pid: descendantPid }));
        receipt.resources.push({
          descendants,
          observedAt: new Date().toISOString(),
          owner: record.owner,
          udid: record.udid,
        });
        return record;
      }
      seen.add(pid);
      pid = parents.get(pid);
    }
  }
  assert.fail("No Session Simulator owned by this MCP process");
};
const act = async (sessionId, name, text) => {
  const before = await observe(sessionId);
  const target = before.observation.nodes.find(
    (node) =>
      node.name === name &&
      node.role === (text === undefined ? "button" : "text-field")
  );
  assert.ok(target);
  await call({
    _tag: "input",
    action:
      text === undefined
        ? { _tag: "activate", target: target.target }
        : { _tag: "fill", target: target.target, text },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
};
try {
  try {
    await control(
      "mcp",
      "call",
      "--tool",
      "agent_device_sessions_list",
      "--params",
      '{"platform":"ios"}'
    );
    assert.fail("Public MCP listed iOS");
  } catch (error) {
    assert.match(String(error.stdout ?? error), /ios_support_matrix_unproven/u);
    receipt.limits.publicMcpGate = true;
  }

  const inputSession = await start();
  await ownResource();
  receipt.limits.oneBinding = await refusal(
    {
      _tag: "start",
      flowSkillName: "ios-public-login",
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
  receipt.limits.privateVariables = await refusal({
    _tag: "variable-request",
    name: "PASSWORD",
    operationId: operation(),
    purpose: "Refusal probe; no private value is supplied",
    replace: false,
    sessionId: inputSession,
  });
  await screenshot("limit-private-variables");
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
  for (const [label, name] of [
    ["systemAlert", "Request notifications permission"],
    ["otherApp", "Open device settings"],
  ]) {
    const sessionId = await start();
    const resource = await ownResource();
    await act(sessionId, "Login name", "Public Shopper");
    await act(sessionId, "Sign in");
    const client = createAgentDeviceClient({
      cwd: resource.directory,
      daemonAuthToken: "",
      daemonBaseUrl: "",
      daemonServerMode: "socket",
      daemonTransport: "socket",
      session: `contingency-ios-${resource.udid}`,
      stateDir: resource.directory,
    });
    const snapshot = await client.capture.snapshot({
      noRecord: true,
      platform: "ios",
      udid: resource.udid,
    });
    const node = snapshot.nodes.find(
      (entry) => entry.kind === "button" && entry.label === name
    );
    assert.ok(node);
    await client.interactions.click({
      platform: "ios",
      ref: `@${node.ref.replace(/^@/u, "")}~s${snapshot.refsGeneration}`,
      udid: resource.udid,
    });
    if (label === "systemAlert") {
      await client.command.alert({
        action: "wait",
        platform: "ios",
        timeoutMs: 30_000,
        udid: resource.udid,
      });
    }
    await screenshot(`boundary-${label}`);
    receipt.limits[label] = await refusal(
      { _tag: "observe", image: false, sessionId },
      /ownership_unknown/u
    );
    const paused = await read(sessionId);
    assert.equal(paused.phase, "paused");
    await screenshot(`limit-${label}`);
    if (label === "otherApp") {
      await execute("xcrun", [
        "simctl",
        "launch",
        resource.udid,
        selection.environment.bundleId,
      ]);
      await screenshot("ownership-return-to-target");
      await click("Recover selected simulator");
      const recovered = await read(sessionId);
      assert.equal(recovered.phase, "running");
      const recoveredResource = await ownResource();
      assert.equal(recoveredResource.udid, resource.udid);
      const observation = await observe(sessionId);
      assert.ok(
        observation.observation.nodes.some(
          (entry) => entry.name === "Signed in as Public Shopper"
        )
      );
      const foregroundReply = await execute("xcrun", [
        "simctl",
        "spawn",
        resource.udid,
        path.join(root, "packages/cli/dist/ios/foreground/foreground"),
      ]);
      const foreground = JSON.parse(foregroundReply.stdout);
      assert.equal(foreground.version, 1);
      assert.equal(foreground.udid, resource.udid);
      assert.equal(foreground.owner.bundleId, selection.environment.bundleId);
      assert.ok(
        Number.isInteger(foreground.owner.pid) && foreground.owner.pid > 0
      );
      receipt.limits.otherAppRecovery = {
        foreground,
        observationId: observation.observation.id,
        phase: recovered.phase,
        sameDevice: true,
        targetApp: foreground.owner.bundleId,
      };
      await screenshot("ownership-recovered");
    }
    await call({ _tag: "close", operationId: operation(), sessionId }, "user");
  }
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
  process.stdout.write(
    "iOS live refusals, transport loss, recovery and ownership pauses passed\n"
  );
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
  await writeFile(
    path.join(artifacts, "limits.json"),
    JSON.stringify(receipt, null, 2)
  );
}
