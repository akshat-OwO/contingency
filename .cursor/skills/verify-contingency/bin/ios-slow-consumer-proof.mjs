/* oxlint-disable eslint/no-await-in-loop -- Audit the owned Session Simulator records sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { iosRpc } from "./ios-workspace-rpc.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(
  directory &&
    process.env.CONTINGENCY_IOS_TEMPLATE &&
    process.env.CONTINGENCY_IOS_FIXTURE
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/ios-workspace-runs"
);
const execute = promisify(execFile);
const control = (...args) =>
  execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env }
  );
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-slow-${process.pid}-${sequence}`;
};
const call = (command) =>
  iosRpc(instance.mcpUrl, "ios.workspace.command", { command, source: "user" });
const receipt = { blockers: [], passed: false, resources: [] };
let sessionId;
let viewer;
try {
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const device = devices.find(
    (entry) => entry.udid === process.env.CONTINGENCY_IOS_TEMPLATE
  );
  assert.ok(device);
  const session = await call({
    _tag: "start",
    flowSkillName: "ios-public-login",
    kind: "teaching",
    operationId: operation(),
    recordingId: null,
    selection: {
      appPath: process.env.CONTINGENCY_IOS_FIXTURE,
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
    },
  });
  sessionId = session.id;
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?ios=${sessionId}`
  );
  await control("browser", "ios-click", "--name", "Prepare Session Simulator");
  const markers = path.join(homedir(), ".contingency/ios-session-simulators");
  // The service refuses a second live iOS binding. Record the resource owned by this broker child.
  const processes = await execute("ps", ["-axo", "pid=,ppid="]);
  const parents = new Map(
    processes.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number))
  );
  for (const file of await readdir(markers)) {
    const record = JSON.parse(
      await readFile(path.join(markers, file), "utf-8")
    );
    let pid = record.owner;
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === instance.mcpPid) {
        receipt.resources.push({
          observedAt: new Date().toISOString(),
          owner: record.owner,
          udid: record.udid,
        });
        break;
      }
      seen.add(pid);
      pid = parents.get(pid);
    }
  }
  assert.equal(receipt.resources.length, 1);
  await control("browser", "ios-click", "--name", "Start recording");
  const access = await iosRpc(instance.mcpUrl, "ios.stream.access", {
    sessionId,
  });
  // oxlint-disable-next-line promise/avoid-new -- Wait for an authenticated response, then deliberately stop reading it.
  await new Promise((resolve, reject) => {
    viewer = request(
      new URL(access.path, instance.mcpUrl),
      { headers: { authorization: `Bearer ${access.token}` } },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`Viewer refused: ${response.statusCode}`));
          return;
        }
        response.pause();
        resolve();
      }
    );
    viewer.setTimeout(30_000, () =>
      viewer.destroy(new Error("Viewer response hung"))
    );
    viewer.once("error", reject);
    viewer.end();
  });
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
  const lost = await call({ _tag: "read", sessionId });
  assert.equal(lost.phase, "paused");
  assert.equal(lost.captureState._tag, "failed");
  const interval = JSON.parse(
    await readFile(
      path.join(
        instance.stateDir,
        "catalog",
        ".recordings",
        lost.recordingId,
        "ios-stream.json"
      ),
      "utf-8"
    )
  );
  assert.equal(interval.status, "incomplete");
  assert.ok(interval.gaps.includes("slow-consumer"));
  receipt.interval = interval;
  receipt.passed = true;
  await control(
    "browser",
    "snapshot",
    "--aria",
    "--path",
    path.join(artifacts, "slow-consumer.aria.txt")
  );
  await control(
    "browser",
    "screenshot",
    "--path",
    path.join(artifacts, "slow-consumer.png")
  );
  process.stdout.write("iOS slow-consumer capture refusal passed\n");
} catch (error) {
  receipt.blockers.push(String(error));
  throw error;
} finally {
  viewer?.destroy();
  if (sessionId) {
    await call({ _tag: "close", operationId: operation(), sessionId }).catch(
      (error) => receipt.blockers.push(`Cleanup: ${error}`)
    );
  }
  await writeFile(
    path.join(artifacts, "slow-consumer.json"),
    JSON.stringify(receipt, null, 2)
  );
}
