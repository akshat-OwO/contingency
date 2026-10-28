/* oxlint-disable eslint/no-await-in-loop -- One owned simulator and its Workspace journey run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { iosRpc } from "./ios-workspace-rpc.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const { createAgentDeviceClient } = await import(
  pathToFileURL(
    path.join(root, "packages/cli/node_modules/agent-device/dist/src/index.js")
  ).href
);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const template = process.env.CONTINGENCY_IOS_TEMPLATE;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
assert.ok(
  directory && template && appPath,
  "Select the owned verification instance, template UDID, and public fixture."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl && instance.driverUrl);
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/ios-workspace-runs"
);
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-proof-${process.pid}-${sequence}`;
};
const journal = [];
const receipt = {
  blockers: [],
  coverage: {},
  resources: [],
  startedAt: new Date().toISOString(),
};
const control = async (...args) => {
  const result = await execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  journal.push({
    action: args[0],
    command: args
      .slice(1)
      .map((value) => (value === appPath ? "<fixture.app>" : value)),
    exitCode: 0,
  });
  return result.stdout;
};
const call = (command, source = "agent") =>
  iosRpc(instance.mcpUrl, "ios.workspace.command", { command, source });
const read = (sessionId) => call({ _tag: "read", sessionId });
const observe = (sessionId) =>
  call({ _tag: "observe", image: false, sessionId });
const click = (name) => control("browser", "ios-click", "--name", name);
const fill = (name, value) =>
  control(
    "browser",
    "fill",
    "--role",
    "textbox",
    "--name",
    name,
    "--value",
    value
  );
const pick = (sessionId, role, name) =>
  control(
    "browser",
    "ios-pick",
    "--session-id",
    sessionId,
    "--role",
    role,
    "--name",
    name
  );
const view = (sessionId) =>
  control("browser", "goto", "--url", `${instance.mcpUrl}?ios=${sessionId}`);
const snapshot = async (name) => {
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
const sessions = [];
const flowSkillName = "ios-public-login";
const loginName = "Public Shopper";
let selection;
const find = (current, role, name) => {
  const nodes =
    current.observation?.nodes.filter(
      (node) => node.role === role && node.name === name && !node.covered
    ) ?? [];
  assert.equal(nodes.length, 1, `Expected one ${role} ${name}`);
  return nodes[0];
};
const agentAction = async (sessionId, role, name, text) => {
  const before = await observe(sessionId);
  const target = find(before, role, name);
  return call({
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
const publicJourney = async (sessionId) => {
  await agentAction(sessionId, "text-field", "Login name", loginName);
  await agentAction(sessionId, "button", "Sign in");
  await agentAction(sessionId, "button", "Open account");
  return agentAction(sessionId, "button", "Return to account");
};
const ownSessionResources = async () => {
  const records = path.join(homedir(), ".contingency/ios-session-simulators");
  const found = [];
  const processList = await execute("ps", ["-axo", "pid=,ppid="]);
  const parents = new Map(
    processList.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number))
  );
  const owned = (initialPid) => {
    let pid = initialPid;
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === instance.mcpPid) {
        return true;
      }
      seen.add(pid);
      pid = parents.get(pid);
    }
    return false;
  };
  for (const file of await readdir(records)) {
    const record = JSON.parse(
      await readFile(path.join(records, file), "utf-8")
    );
    if (owned(record.owner)) {
      const descendants = [...parents]
        .filter(([candidate]) => {
          let pid = candidate;
          const seen = new Set();
          while (pid && !seen.has(pid)) {
            if (pid === record.owner) {
              return true;
            }
            seen.add(pid);
            pid = parents.get(pid);
          }
          return false;
        })
        .map(([pid, parent]) => ({ parent, pid }));
      found.push({
        ...record,
        descendants,
        observedAt: new Date().toISOString(),
      });
    }
  }
  return found;
};
const rotate = async (orientation) => {
  const resources = await ownSessionResources();
  assert.equal(
    resources.length,
    1,
    "Rotate only this proof's single Session Simulator."
  );
  const [resource] = resources;
  const client = createAgentDeviceClient({
    cwd: resource.directory,
    daemonAuthToken: "",
    daemonBaseUrl: "",
    daemonServerMode: "socket",
    daemonTransport: "socket",
    debug: false,
    session: `contingency-ios-${resource.udid}`,
    stateDir: resource.directory,
  });
  await client.command.orientation({
    orientation,
    platform: "ios",
    udid: resource.udid,
  });
};
try {
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const device = devices.find((entry) => entry.udid === template);
  assert.ok(device && device.runtimeVersion === "26.5");
  selection = {
    appPath,
    device,
    environment: {
      build: "1",
      bundleId: "dev.contingency.ioslogin",
      deviceType: device.deviceType,
      runtimeVersion: device.runtimeVersion,
    },
    outcomes: [{ name: `Signed in as ${loginName}`, role: "text" }],
    setup: {
      conditions: [{ name: "Public login fixture", role: "text" }],
      kind: "fresh-install",
    },
  };
  // Teaching starts through the actual Workspace setup controls.
  await control("browser", "goto", "--url", instance.mcpUrl);
  await control("browser", "click", "--role", "button", "--name", "iOS");
  await fill("Flow skill name", flowSkillName);
  await control(
    "browser",
    "select",
    "--role",
    "combobox",
    "--name",
    "Device",
    "--value",
    template
  );
  for (const [name, value] of [
    ["Simulator app path", appPath],
    ["Bundle identifier", selection.environment.bundleId],
    ["App build", "1"],
    ["Starting screen element", "Public login fixture"],
    ["Done when element", `Signed in as ${loginName}`],
  ]) {
    await fill(name, value);
  }
  await click("Open session");
  const list = await iosRpc(instance.mcpUrl, "ios.workspace.list", {});
  const teaching = list.find((entry) => entry.flowSkillName === flowSkillName);
  assert.ok(teaching);
  sessions.push(teaching.id);
  await view(teaching.id);
  await click("Prepare Session Simulator");
  receipt.resources.push(...(await ownSessionResources()));
  await snapshot("teaching-prepared");
  process.stdout.write("iOS Workspace preparation passed\n");
  await click("Start recording");
  await pick(teaching.id, "text-field", "Login name");
  await fill("Text for Login name", loginName);
  await click("Type");
  await pick(teaching.id, "button", "Sign in");
  const portrait = await call(
    { _tag: "observe", image: false, sessionId: teaching.id },
    "user"
  );
  await rotate("landscape-left");
  const landscape = await call(
    { _tag: "observe", image: false, sessionId: teaching.id },
    "user"
  );
  assert.ok(landscape.observation.width > landscape.observation.height);
  await assert.rejects(
    call(
      {
        _tag: "pick",
        frame: {
          height: portrait.observation.height,
          width: portrait.observation.width,
        },
        observationId: portrait.observation.id,
        operationId: operation(),
        point: { x: 0.5, y: 0.5 },
        sessionId: teaching.id,
      },
      "user"
    ),
    /The stream size or orientation changed. No input was sent./u
  );
  const rotatedRecording = await read(teaching.id);
  assert.equal(rotatedRecording.captureState._tag, "recording");
  await control("browser", "ios-orientation", "--orientation", "landscape");
  await snapshot("rotation-landscape");
  receipt.coverage.rotation = true;
  await pick(teaching.id, "button", "Open account");
  await pick(teaching.id, "button", "Return to account");
  await rotate("portrait");
  await control("browser", "ios-orientation", "--orientation", "portrait");
  await snapshot("teaching-outcome");
  await click("Stop recording");
  const stopped = await read(teaching.id);
  assert.equal(stopped.captureState._tag, "ready");
  receipt.coverage.teaching = true;
  await click("Close session");
  const { recordingId } = stopped;
  const interval = JSON.parse(
    await readFile(
      path.join(
        instance.stateDir,
        "catalog",
        ".recordings",
        recordingId,
        "ios-stream.json"
      ),
      "utf-8"
    )
  );
  assert.equal(interval.status, "stopped");
  assert.deepEqual(interval.gaps, []);
  assert.ok(
    interval.firstSampledMs >= interval.sampledAfterMs &&
      interval.lastSequence >= interval.firstSequence
  );
  await writeFile(
    path.join(artifacts, "stream-interval.json"),
    JSON.stringify(interval, null, 2)
  );
  const claim = operation();
  await tool("agent_teaching_recording_claim", {
    action: "take",
    claimOperationId: null,
    error: null,
    operationId: claim,
    recordingId,
  });
  const timeline = await tool("agent_teaching_timeline_get", {
    claimOperationId: claim,
    cursor: 0,
    recordingId,
  });
  const actions = timeline.entries.filter((entry) => entry._tag === "action");
  assert.deepEqual(
    actions.map((entry) => entry.kind),
    ["fill", "activate", "activate", "activate"]
  );
  assert.deepEqual(
    actions.map((entry) => entry.description),
    [
      "Enter public fixture text in text-field Login name",
      "Activate button Sign in",
      "Activate button Open account",
      "Activate button Return to account",
    ]
  );
  assert.ok(actions.every((entry) => entry.before.ios && entry.after.ios));
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  const content = `---\nname: ${flowSkillName}\ndescription: Sign in with a public login name, open account details, and return to the account. Use for the public iOS Workspace fixture.\n---\n\n# Public login and account\n\n1. Enter ${loginName} in Login name. Done when: the field shows ${loginName}.\n2. Activate Sign in. Done when: Signed in as ${loginName} is visible.\n3. Activate Open account. Done when: Account details is visible.\n4. Activate Return to account. Done when: Signed in as ${loginName} is visible.\n`;
  await tool("agent_flow_skill_save", {
    claimOperationId: claim,
    files: [{ content, path: "SKILL.md" }],
    operationId: operation(),
    recordingId,
  });
  receipt.coverage.learning = true;
  process.stdout.write("iOS Teaching and Flow Skill learning passed\n");
  for (const kind of ["dry-run", "run"]) {
    const started = await call({
      _tag: "start",
      flowSkillName,
      kind,
      operationId: operation(),
      recordingId: kind === "dry-run" ? recordingId : null,
      selection,
    });
    sessions.push(started.id);
    await view(started.id);
    await click("Prepare Session Simulator");
    receipt.resources.push(...(await ownSessionResources()));
    const current = await publicJourney(started.id);
    const finished = await call({
      _tag: "complete",
      assessment: {
        explanation: `Signed in as ${loginName} is visible after returning from Account details.`,
        observationId: current.observation.id,
        outcome: "working",
      },
      operationId: operation(),
      sessionId: started.id,
    });
    assert.equal(finished.assessment.outcome, "working");
    await snapshot(`${kind}-passed`);
    receipt.coverage[kind] = true;
    if (kind === "dry-run") {
      await click("Verify flow");
      const verified = await read(started.id);
      assert.equal(verified.captureState._tag, "verified");
      assert.equal(verified.cleanup._tag, "purged");
      const skill = await readFile(
        path.join(instance.stateDir, "catalog", flowSkillName, "SKILL.md"),
        "utf-8"
      );
      assert.match(skill, /"platform":"ios"/u);
      const verification = await readFile(
        path.join(
          instance.stateDir,
          "catalog",
          flowSkillName,
          "references/verification.md"
        ),
        "utf-8"
      );
      assert.match(verification, /- Platform: ios/u);
      receipt.coverage.verificationAndPurge = true;
      await snapshot("verified-purged");
    }
    process.stdout.write(`iOS ${kind} passed\n`);
  }
} catch (error) {
  receipt.blockers.push(String(error));
  for (const resource of await ownSessionResources().catch(() => [])) {
    const display = await execute("xcrun", [
      "simctl",
      "io",
      resource.udid,
      "enumerate",
    ]);
    await writeFile(
      path.join(artifacts, "failed-display-state.txt"),
      display.stdout
        .split("\n")
        .filter((line) =>
          /Display class|UI Orientation|Screen Type|IOSurface port|width|height/u.test(
            line
          )
        )
        .join("\n")
    );
  }
  await snapshot("blocked").catch((evidenceError) =>
    receipt.blockers.push(`Evidence capture: ${evidenceError}`)
  );
  throw error;
} finally {
  receipt.resources.push(...(await ownSessionResources().catch(() => [])));
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
  receipt.completedAt = new Date().toISOString();
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(
      {
        ...receipt,
        resources: receipt.resources.map(
          ({ directory: _directory, ...resource }) => resource
        ),
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2)
  );
}
