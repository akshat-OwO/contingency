/* oxlint-disable eslint/no-await-in-loop -- One owned simulator and its Workspace journey run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, watch, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { foldWithPanelReadback } from "./ios-display-proof-device.mjs";
import {
  awaitProofStage,
  proofCaptureStage,
} from "./ios-display-proof-events.mjs";
import {
  selectedSimulatorResource,
  simulatorInventory,
} from "./ios-proof-resources.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

// Display changes happen to the selected simulator from outside Contingency, as a
// person rotating or folding the device would. Every journey step still passes
// through Workspace or public MCP. CONTINGENCY_IOS_DISPLAY_CASE picks the case:
// rotation, fold, display-refusal, or stop-race.
const root = path.resolve(import.meta.dirname, "../../../..");
const mode = process.env.CONTINGENCY_IOS_DISPLAY_CASE;
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const selected = process.env.CONTINGENCY_IOS_SELECTED;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
assert.ok(["rotation", "fold", "display-refusal", "stop-race"].includes(mode));
assert.ok(directory && selected && appPath);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const artifacts = path.join(
  root,
  process.env.CONTINGENCY_IOS_PROOF_ARTIFACTS ??
    `.cursor/skills/verify-contingency/artifacts/ios-display-${mode}`
);
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
const { createAgentDeviceClient } = await import(
  pathToFileURL(
    path.join(root, "packages/cli/node_modules/agent-device/dist/src/index.js")
  ).href
);
const backendSession = `contingency-ios-${selected}`;
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-display-${process.pid}-${sequence}`;
};
const journal = [];
const receipt = {
  blockers: [],
  coverage: {},
  displayChanges: [],
  mode,
  ownedDaemons: [],
  startedAt: new Date().toISOString(),
};
const control = async (...args) => {
  const startedAt = new Date().toISOString();
  const result = await execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  journal.push({
    command: args.map((value) => (value === appPath ? "<fixture.app>" : value)),
    completedAt: new Date().toISOString(),
    startedAt,
  });
  return result.stdout;
};
const tool = async (name, params) => {
  try {
    return JSON.parse(
      await control(
        "mcp",
        "call",
        "--tool",
        name,
        "--params",
        JSON.stringify(params)
      )
    );
  } catch (error) {
    throw new Error(
      `${name} failed: ${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? error}`,
      { cause: error }
    );
  }
};
const call = (command, source = "agent") =>
  source === "agent"
    ? tool("agent_device_workspace", { command, platform: "ios" })
    : iosRpc(instance.mcpUrl, "ios.workspace.command", { command, source });
const read = (sessionId) => call({ _tag: "read", sessionId }, "user");
const observe = (sessionId, source = "user") =>
  call({ _tag: "observe", image: false, sessionId }, source);
const click = (name) => control("browser", "ios-click", "--name", name);
const fillField = (name, value) =>
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
const mirror = (orientation) =>
  control("browser", "ios-orientation", "--orientation", orientation);
const view = (sessionId) =>
  control("browser", "goto", "--url", `${instance.mcpUrl}?ios=${sessionId}`);
const evidence = async (name) => {
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
const find = (current, role, name) => {
  const nodes =
    current.observation?.nodes.filter(
      (node) => node.role === role && node.name === name && !node.covered
    ) ?? [];
  assert.equal(nodes.length, 1, `Expected one ${role} ${name}`);
  return nodes[0];
};
const viewport = (current) => ({
  height: current.observation.height,
  landscape: current.observation.width > current.observation.height,
  width: current.observation.width,
});

// Read only the product-owned journal for this exact selected simulator.
const productDaemon = async () => {
  const base = tmpdir();
  const owned = [];
  for (const entry of await readdir(base)) {
    const candidate = path.join(base, entry);
    if (
      entry.startsWith("contingency-ios-") &&
      existsSync(path.join(candidate, "sessions", backendSession))
    ) {
      owned.push(candidate);
    }
  }
  assert.equal(owned.length, 1, "Expected one private daemon for this UDID");
  const [state] = owned;
  if (!receipt.ownedDaemons.includes(state)) {
    receipt.ownedDaemons.push(state);
  }
  return state;
};
// Use exactly the socket configuration owned by ios-runtime, never a global daemon.
// The product has already opened this session. Validate its binding before mutation.
const deviceCommand = async (command, value) => {
  const stateDir = await productDaemon();
  const client = createAgentDeviceClient({
    cwd: stateDir,
    daemonAuthToken: "",
    daemonBaseUrl: "",
    daemonServerMode: "socket",
    daemonTransport: "socket",
    debug: false,
    responseLevel: "full",
    session: backendSession,
    stateDir,
  });
  const backendSessions = await client.sessions.list();
  const bound = backendSessions.find((entry) => entry.name === backendSession);
  assert.equal(bound?.device.ios?.udid, selected);
  const identifiers = {
    platform: "ios",
    requestId: randomUUID(),
    udid: selected,
  };
  const output =
    command === "orientation"
      ? await client.command.orientation({ orientation: value, ...identifiers })
      : await client.command.fold({ pose: value, ...identifiers });
  return { exit: 0, output, session: backendSession, stateDir };
};
let inventorySequence = 0;
const displayState = async () => {
  const enumerated = await execute("xcrun", [
    "simctl",
    "io",
    selected,
    "enumerate",
  ]);
  inventorySequence += 1;
  await writeFile(
    path.join(artifacts, `display-inventory-${inventorySequence}.txt`),
    enumerated.stdout
  );
  const devices = await execute("xcrun", [
    "devicectl",
    "device",
    "info",
    "displays",
    "--device",
    selected,
    "-j",
    "-",
  ]);
  const integrated = JSON.parse(devices.stdout).result.displays.filter(
    (display) => display.type.integrated
  );
  const ports = enumerated.stdout
    .split(/\nPort:\n/u)
    .filter((port) => /Display class: 0\n/u.test(port))
    .map((port) => ({
      height: Number(/Default height: (?<value>\d+)/u.exec(port)?.groups.value),
      power: /Power state: (?<value>\w+)/u.exec(port)?.groups.value,
      uuid: /UUID: (?<value>[\dA-F-]{36})/u.exec(port)?.groups.value,
      width: Number(/Default width: (?<value>\d+)/u.exec(port)?.groups.value),
    }));
  return {
    active: integrated
      .filter((display) => display.active)
      .map((display) => display.name),
    orientations: [
      ...enumerated.stdout.matchAll(/UI Orientation: (?<value>[^\n]+)/gu),
    ].map((match) => match.groups.value.trim()),
    panels: integrated.map((display) => ({
      active: display.active,
      name: display.name,
      nativeSize: display.nativeSize,
    })),
    ports,
  };
};
// CoreDevice readback is the event that a pose took effect. Bounded for a hang.
const awaitActivePanel = async (name) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await displayState();
    if (state.active.length === 1 && state.active[0] === name) {
      return state;
    }
  }
  throw new Error(`CoreDevice never reported ${name} as the active panel`);
};
const rotate = async (orientation) => {
  const before = await displayState();
  const result = await deviceCommand("orientation", orientation);
  const after = await displayState();
  const change = { after, before, kind: "orientation", orientation, result };
  receipt.displayChanges.push(change);
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  return change;
};
const fold = async (pose, panel) => {
  const before = await displayState();
  assert.notDeepEqual(
    before.active,
    [panel],
    "Fold must change the active panel"
  );
  const { result, after } = await foldWithPanelReadback(
    () => deviceCommand("fold", pose),
    () => awaitActivePanel(panel)
  );
  const change = { after, before, kind: "fold", pose, result };
  receipt.displayChanges.push(change);
  return change;
};
// agent-device's session journal records every request's start and finish.
const backendJournal = async () =>
  path.join(await productDaemon(), "sessions", backendSession);
const backendRequests = async () => {
  const contents = await readFile(
    path.join(await backendJournal(), "events.ndjson"),
    "utf-8"
  );
  const byId = new Map();
  for (const line of contents.split("\n")) {
    const entry = line.trim() ? JSON.parse(line) : null;
    if (entry?.requestId) {
      const current = byId.get(entry.requestId) ?? {
        command: entry.command,
        end: null,
        requestId: entry.requestId,
        start: null,
        status: null,
      };
      if (entry.kind === "request.started") {
        current.start = entry.ts;
      } else if (entry.kind === "request.finished") {
        current.end = entry.ts;
        current.status = entry.status;
      }
      byId.set(entry.requestId, current);
    }
  }
  return [...byId.values()]
    .filter((entry) => entry.start !== null)
    .toSorted((a, b) => a.start.localeCompare(b.start));
};
const inputCommands = new Set(["fill", "press", "click", "type", "tap"]);
const dispatched = async () => {
  const requests = await backendRequests();
  return requests.filter((entry) => inputCommands.has(entry.command));
};
const recordingFile = (recordingId, name) =>
  path.join(instance.stateDir, "catalog", ".recordings", recordingId, name);
const events = async (recordingId) => {
  const contents = await readFile(
    recordingFile(recordingId, "events.jsonl"),
    "utf-8"
  );
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
};
const interval = async (recordingId) =>
  JSON.parse(await readFile(recordingFile(recordingId, "ios-stream.json")));
// Read live mirror packets after Stop: the transport continues, the recording does not.
const mirrorPackets = async (sessionId, count) => {
  const access = await iosRpc(instance.mcpUrl, "ios.stream.access", {
    sessionId,
  });
  // oxlint-disable-next-line promise/avoid-new -- Response data events are the packets.
  return new Promise((resolve, reject) => {
    const packets = [];
    let pending = "";
    const viewer = request(
      new URL(access.path, instance.mcpUrl),
      { headers: { authorization: `Bearer ${access.token}` } },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`Viewer refused: ${response.statusCode}`));
          return;
        }
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          pending += chunk;
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const value = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (value._tag === "jpeg") {
              packets.push({
                height: value.height,
                timestamp: value.timestamp,
                width: value.width,
              });
            }
            if (packets.length >= count) {
              viewer.destroy();
              resolve(packets);
              return;
            }
            newline = pending.indexOf("\n");
          }
        });
        response.once("end", () => resolve(packets));
      }
    );
    viewer.setTimeout(30_000, () =>
      viewer.destroy(new Error("Mirror packets hung"))
    );
    viewer.once("error", (error) =>
      error.message === "socket hang up" ? resolve(packets) : reject(error)
    );
    viewer.end();
  });
};

const loginName = "Test Shopper";
const password = "fixture-password";
const flowSkillName = `ios-display-${mode}`;
const sessions = [];
let device;
let selection;
const startTeaching = async (name = flowSkillName) => {
  const started = await call(
    {
      _tag: "start",
      flowSkillName: name,
      kind: "teaching",
      operationId: operation(),
      recordingId: null,
      selection,
    },
    "user"
  );
  sessions.push(started.id);
  await view(started.id);
  await click("Allow");
  await click("Prepare selected simulator");
  await click("Start recording");
  return started.id;
};
const teachSignIn = async (sessionId) => {
  await pick(sessionId, "text-field", "Login name");
  await fillField("Text for Login name", loginName);
  await click("Type");
  await pick(sessionId, "secure-text-field", "Password");
  await click("Request Variable");
  await fillField("PASSWORD", password);
  await click(`Supply PASSWORD`);
  await click(`Enter PASSWORD`);
  await pick(sessionId, "button", "Sign in privately");
};
const stopTeaching = async (sessionId) => {
  await click("Stop recording");
  const stopped = await read(sessionId);
  assert.equal(stopped.captureState._tag, "ready");
  const retained = await interval(stopped.recordingId);
  await writeFile(
    path.join(artifacts, `${sessionId}-stream-interval.json`),
    JSON.stringify(retained, null, 2)
  );
  return { interval: retained, stopped };
};
const timeline = async (recordingId) => {
  const claim = operation();
  await tool("agent_teaching_recording_claim", {
    action: "take",
    claimOperationId: null,
    error: null,
    operationId: claim,
    recordingId,
  });
  const retained = await tool("agent_teaching_timeline_get", {
    claimOperationId: claim,
    cursor: 0,
    recordingId,
  });
  await writeFile(
    path.join(artifacts, `${recordingId}-timeline.json`),
    JSON.stringify(retained, null, 2)
  );
  return { claim, entries: retained.entries };
};
const agentAction = async (sessionId, role, name, text) => {
  const before = await observe(sessionId, "agent");
  const { target } = find(before, role, name);
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
const agentSignIn = async (sessionId) => {
  await agentAction(sessionId, "text-field", "Login name", loginName);
  const supplied = await read(sessionId);
  const variable = supplied.variables.find(
    (entry) => entry.name === "PASSWORD"
  );
  await call(
    {
      _tag: "variable-supply",
      name: "PASSWORD",
      operationId: operation(),
      requestId: variable.requestId,
      sessionId,
      value: password,
    },
    "user"
  );
  const before = await observe(sessionId, "agent");
  await call({
    _tag: "input",
    action: {
      _tag: "variable",
      name: "PASSWORD",
      target: find(before, "secure-text-field", "Password").target,
    },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
  return agentAction(sessionId, "button", "Sign in privately");
};
const learn = async (recordingId) => {
  const { claim, entries } = await timeline(recordingId);
  const content = `---\nname: ${flowSkillName}\ndescription: Sign in with test inputs, open account details, and return. Use for the iOS display-change fixture.\ninputs:\n  - name: PASSWORD\n    description: Test account password\n---\n\n# Login and account across display changes\n\n1. Enter ${loginName} in Login name. Done when: the field shows ${loginName}.\n2. Fill Password with {{PASSWORD}}. Done when: Sign in privately is visible.\n3. Activate Sign in privately. Done when: Signed in as ${loginName} is visible.\n4. Activate Open account. Done when: Account details is visible.\n5. Activate Return to account. Done when: Signed in as ${loginName} is visible.\n`;
  await tool("agent_flow_skill_save", {
    claimOperationId: claim,
    files: [{ content, path: "SKILL.md" }],
    operationId: operation(),
    recordingId,
  });
  return entries;
};
const assertStoppedLast = (retained) => {
  const stoppedAt = retained.findIndex((entry) => entry._tag === "stopped");
  assert.equal(stoppedAt, retained.length - 1, "No event may follow Stop");
  assert.deepEqual(
    retained.map((entry) => entry.seq),
    retained.map((_, index) => index)
  );
};

const rotationCase = async () => {
  const teaching = await startTeaching();
  await teachSignIn(teaching);
  const portrait = await observe(teaching);
  assert.equal(viewport(portrait).landscape, false);
  await rotate("landscape-left");
  await mirror("landscape");
  const landscape = await observe(teaching);
  assert.equal(landscape.phase, "running");
  assert.equal(viewport(landscape).landscape, true);
  find(landscape, "button", "Open account");
  await evidence("teaching-landscape");
  await pick(teaching, "button", "Open account");
  const details = await observe(teaching);
  find(details, "text", "Account details");
  assert.equal(viewport(details).landscape, true);
  await rotate("portrait");
  await mirror("portrait");
  await pick(teaching, "button", "Return to account");
  const returned = await observe(teaching);
  assert.equal(viewport(returned).landscape, false);
  find(returned, "text", `Signed in as ${loginName}`);
  const { interval: retained, stopped } = await stopTeaching(teaching);
  assert.equal(retained.status, "stopped");
  assert.deepEqual(retained.gaps, []);
  assertStoppedLast(await events(stopped.recordingId));
  await click("Close session");
  const entries = await learn(stopped.recordingId);
  const actions = entries.filter((entry) => entry._tag === "action");
  assert.deepEqual(
    actions.map((entry) => entry.description),
    [
      "Enter public fixture text in text-field Login name",
      `Enter Variable PASSWORD: ${password} in secure-text-field Password`,
      "Activate button Sign in privately",
      "Activate button Open account",
      "Activate button Return to account",
    ]
  );
  receipt.coverage.teaching = {
    landscapeObservation: viewport(landscape),
    picksAfterRotation: ["Open account", "Return to account"],
    portraitObservation: viewport(portrait),
    streamInterval: retained,
  };
  const { appPath: _installed, ...installedSelection } = selection;
  for (const kind of ["dry-run", "run"]) {
    const started = await call({
      _tag: "start",
      flowSkillName,
      kind,
      operationId: operation(),
      recordingId: kind === "dry-run" ? stopped.recordingId : null,
      selection: installedSelection,
    });
    sessions.push(started.id);
    await view(started.id);
    await click("Prepare selected simulator");
    await agentSignIn(started.id);
    await rotate("landscape-left");
    await mirror("landscape");
    let current = await agentAction(started.id, "button", "Open account");
    find(current, "text", "Account details");
    assert.equal(viewport(current).landscape, true);
    await evidence(`${kind}-landscape`);
    await rotate("portrait");
    await mirror("portrait");
    current = await agentAction(started.id, "button", "Return to account");
    find(current, "text", `Signed in as ${loginName}`);
    assert.equal(viewport(current).landscape, false);
    const finished = await call({
      _tag: "complete",
      assessment: {
        explanation: `Signed in as ${loginName} is visible after rotating and returning from Account details.`,
        observationId: current.observation.id,
        outcome: "working",
      },
      operationId: operation(),
      sessionId: started.id,
    });
    assert.equal(finished.assessment.outcome, "working");
    await evidence(`${kind}-passed`);
    receipt.coverage[kind] = { outcome: "working", rotatedDuringRun: true };
    if (kind === "dry-run") {
      await click("Verify flow");
      const verified = await read(started.id);
      assert.equal(verified.captureState._tag, "verified");
    }
  }
};

const foldCase = async () => {
  const initial = await displayState();
  receipt.coverage.initialPanels = initial;
  const teaching = await startTeaching();
  await teachSignIn(teaching);
  const closed = await observe(teaching);
  const [outer] = initial.active;
  const inner = initial.panels.find((panel) => panel.name !== outer)?.name;
  assert.ok(outer && inner);
  await fold("open", inner);
  let unfolded;
  try {
    unfolded = await observe(teaching);
  } catch (error) {
    receipt.coverage.unfoldRefusal = String(error);
    const refused = await read(teaching);
    receipt.coverage.unfoldRefusalState = {
      captureGaps: refused.captureGaps,
      error: refused.error,
      phase: refused.phase,
      refusal: refused.refusal,
    };
    await evidence("unfold-refused");
    throw error;
  }
  assert.equal(unfolded.phase, "running");
  find(unfolded, "button", "Open account");
  const unfoldedViewport = viewport(unfolded);
  await mirror(unfoldedViewport.landscape ? "landscape" : "portrait");
  await evidence("teaching-unfolded");
  await pick(teaching, "button", "Open account");
  find(await observe(teaching), "text", "Account details");
  await fold("closed", outer);
  const refolded = await observe(teaching);
  assert.equal(refolded.phase, "running");
  find(refolded, "button", "Return to account");
  await mirror(viewport(refolded).landscape ? "landscape" : "portrait");
  await evidence("teaching-refolded");
  await pick(teaching, "button", "Return to account");
  find(await observe(teaching), "text", `Signed in as ${loginName}`);
  const { interval: retained, stopped } = await stopTeaching(teaching);
  assert.equal(retained.status, "stopped");
  assert.deepEqual(retained.gaps, []);
  assertStoppedLast(await events(stopped.recordingId));
  await click("Close session");
  const entries = await learn(stopped.recordingId);
  assert.deepEqual(
    entries
      .filter((entry) => entry._tag === "action")
      .map((entry) => entry.description),
    [
      "Enter public fixture text in text-field Login name",
      `Enter Variable PASSWORD: ${password} in secure-text-field Password`,
      "Activate button Sign in privately",
      "Activate button Open account",
      "Activate button Return to account",
    ]
  );
  receipt.coverage.fold = {
    closedObservation: viewport(closed),
    refoldedObservation: viewport(refolded),
    streamInterval: retained,
    unfoldedObservation: unfoldedViewport,
  };
  const { appPath: _installed, ...installedSelection } = selection;
  for (const kind of ["dry-run", "run"]) {
    const started = await call({
      _tag: "start",
      flowSkillName,
      kind,
      operationId: operation(),
      recordingId: kind === "dry-run" ? stopped.recordingId : null,
      selection: installedSelection,
    });
    sessions.push(started.id);
    await view(started.id);
    await click("Prepare selected simulator");
    await agentSignIn(started.id);
    await fold("open", inner);
    let current = await observe(started.id, "agent");
    const openedViewport = viewport(current);
    await mirror(openedViewport.landscape ? "landscape" : "portrait");
    current = await agentAction(started.id, "button", "Open account");
    find(current, "text", "Account details");
    await evidence(`${kind}-unfolded`);
    await fold("closed", outer);
    current = await observe(started.id, "agent");
    const closedViewport = viewport(current);
    await mirror(closedViewport.landscape ? "landscape" : "portrait");
    current = await agentAction(started.id, "button", "Return to account");
    find(current, "text", `Signed in as ${loginName}`);
    await evidence(`${kind}-refolded`);
    const finished = await call({
      _tag: "complete",
      assessment: {
        explanation: `Signed in as ${loginName} is visible after folding and returning from Account details.`,
        observationId: current.observation.id,
        outcome: "working",
      },
      operationId: operation(),
      sessionId: started.id,
    });
    assert.equal(finished.assessment.outcome, "working");
    receipt.coverage[kind] = {
      outcome: "working",
      refoldedObservation: closedViewport,
      unfoldedObservation: openedViewport,
    };
    if (kind === "dry-run") {
      await click("Verify flow");
      const verified = await read(started.id);
      assert.equal(verified.captureState._tag, "verified");
    }
  }
};

// simctl exposes display power but no operation that replaces an integrated port UUID.
// A powered-off integrated port must be refused, then explicitly recovered.
const displayRefusalCase = async () => {
  const teaching = await startTeaching();
  await teachSignIn(teaching);
  const before = await displayState();
  assert.equal(before.ports.length, 1);
  const display = before.ports[0].uuid;
  const power = async (value) => {
    await execute("xcrun", [
      "simctl",
      "io",
      selected,
      "screenConfig",
      `--display=${display}`,
      "power",
      value,
    ]);
    receipt.displayChanges.push({
      kind: "power",
      state: await displayState(),
      value,
    });
  };
  try {
    await power("off");
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
    const refused = await read(teaching);
    assert.equal(refused.phase, "paused");
    assert.equal(refused.refusal.code, "capture_incomplete");
    assert.equal(refused.captureState._tag, "failed");
    await evidence("display-unavailable");
    await power("on");
    await click("Recover selected simulator");
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
    const recovered = await observe(teaching);
    assert.equal(recovered.phase, "running");
    assert.equal(recovered.captureState._tag, "failed");
    find(recovered, "button", "Open account");
    await pick(teaching, "button", "Open account");
    find(await observe(teaching), "text", "Account details");
    await pick(teaching, "button", "Return to account");
    find(await observe(teaching), "text", `Signed in as ${loginName}`);
    await evidence("display-recovered");
    const after = await displayState();
    assert.equal(after.ports[0].uuid, display);
    receipt.coverage.displayRefusal = {
      after,
      before,
      code: refused.refusal.code,
      recordingRemainsFailed: true,
      recoveredPhase: recovered.phase,
      uuidReplacementProven: false,
    };
  } finally {
    await power("on");
  }
};

// Fire an input from a second client, then press Stop in Workspace once the
// backend reports the chosen stage. Product serialization decides the order.
const stopRace = async (stage) => {
  const teaching = await startTeaching(`${flowSkillName}-${stage}`);
  const before = await observe(teaching);
  const field = find(before, "text-field", "Login name");
  const baseline = await dispatched();
  const inputSent = new Date().toISOString();
  const settle = async () => {
    try {
      const value = await call(
        {
          _tag: "input",
          action: { _tag: "fill", target: field.target, text: loginName },
          observationId: before.observation.id,
          operationId: operation(),
          sessionId: teaching,
        },
        "user"
      );
      return { at: new Date().toISOString(), value };
    } catch (error) {
      return { at: new Date().toISOString(), error: String(error) };
    }
  };
  const input = settle();
  // Backend request logs are the event: fill started, or fill ended and a settle capture began.
  const requestsDirectory = await backendJournal();
  const reachedStage = async () => {
    const requests = await backendRequests();
    const fill = requests.find(
      (entry) =>
        entry.command === "fill" &&
        !baseline.some((prior) => prior.requestId === entry.requestId)
    );
    if (stage === "in-flight" && fill && fill.end === null) {
      return { fill };
    }
    const capture = fill?.end ? proofCaptureStage(requests, fill) : null;
    return stage === "settling" && capture ? { capture, fill } : null;
  };
  // Each directory change event triggers one re-read, bounded by a hang guard.
  const awaitStage = async () => {
    const signal = AbortSignal.timeout(60_000);
    const changes = watch(requestsDirectory, { signal });
    try {
      return await awaitProofStage(changes, () =>
        reachedStage().catch(() => null)
      );
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      return null;
    }
  };
  const reached = await awaitStage();
  assert.ok(reached, `Backend never reached ${stage}`);
  const stopPressed = new Date().toISOString();
  const stopClick = click("Stop recording");
  const [inputResult, stopResult] = await Promise.all([input, stopClick]);
  const { clickedAt: stopClicked } = JSON.parse(stopResult);
  assert.ok(stopClicked);
  const stopReplied = new Date().toISOString();
  assert.equal(inputResult.error, undefined, inputResult.error);
  assert.ok(stopPressed < inputResult.at, "Stop must race the input");
  const stopped = await read(teaching);
  assert.equal(stopped.captureState._tag, "ready");
  const retainedEvents = await events(stopped.recordingId);
  assertStoppedLast(retainedEvents);
  const actions = retainedEvents.filter((entry) => entry._tag === "action");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "fill");
  const retained = await interval(stopped.recordingId);
  assert.equal(retained.status, "stopped");
  assert.deepEqual(retained.gaps, []);
  // The mirror still streams after Stop; none of it joins the recording.
  const after = await mirrorPackets(teaching, 5);
  assert.equal(after.length, 5);
  assert.ok(after.every((packet) => packet.timestamp > retained.lastSampledMs));
  assert.deepEqual(await interval(stopped.recordingId), retained);
  assert.deepEqual(await events(stopped.recordingId), retainedEvents);
  const settled = await observe(teaching);
  const backendInputs = await dispatched();
  const inputs = backendInputs.filter(
    (entry) => !baseline.some((prior) => prior.requestId === entry.requestId)
  );
  assert.deepEqual(
    inputs.map((entry) => entry.command),
    ["fill"],
    "Exactly one backend input may be dispatched"
  );
  const requests = await backendRequests();
  receipt.coverage[`stop-${stage}`] = {
    reached,
    requests,
    stopClicked,
    stopPressed,
    stopReplied,
  };
  await writeFile(
    path.join(artifacts, `stop-${stage}-backend-requests.json`),
    JSON.stringify(requests, null, 2)
  );
  if (stage === "in-flight") {
    assert.ok(
      stopClicked < inputs[0].end,
      "Stop must be pressed before backend input ends"
    );
  } else {
    assert.ok(
      reached.fill.end < stopPressed,
      "Settling follows backend input completion"
    );
    const settledRequests = await backendRequests();
    const capture = settledRequests.find(
      (entry) => entry.requestId === reached.capture.requestId
    );
    assert.ok(
      stopClicked < capture.end,
      "Stop must be pressed before settle capture ends"
    );
  }
  const retainedTimeline = await timeline(stopped.recordingId);
  assert.deepEqual(
    retainedTimeline.entries
      .filter((entry) => entry._tag === "action")
      .map((entry) => entry.description),
    ["Enter public fixture text in text-field Login name"]
  );
  await evidence(`stop-${stage}`);
  const daemon = await productDaemon();
  const helper = await selectedSimulatorResource(instance, selected);
  await click("Close session");
  receipt.coverage[`stop-${stage}`] = {
    backendInputs: inputs,
    eventsAfterStop: 0,
    helper,
    inputCompleted: inputResult.at,
    inputSent,
    mirrorPacketsAfterStop: after,
    observedAfterStop: settled.observation.nodes
      .filter((node) => node.role === "text-field")
      .map((node) => node.name),
    privateDaemon: daemon,
    reached,
    retainedInterval: retained,
    stopClicked,
    stopPressed,
    stopReplied,
    timeline: retainedEvents.map((entry) => entry._tag),
  };
};

const inventoryBefore = await simulatorInventory();
try {
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const discovered = devices.find((entry) => entry.udid === selected);
  assert.ok(discovered);
  const { state: _state, ...chosen } = discovered;
  device = chosen;
  receipt.cell = {
    deviceType: device.deviceType,
    runtimeVersion: device.runtimeVersion,
  };
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
      conditions: [{ name: "Login fixture", role: "text" }],
      kind: "restart-app",
    },
  };
  if (mode === "rotation") {
    await rotationCase();
  } else if (mode === "fold") {
    await foldCase();
  } else if (mode === "display-refusal") {
    await displayRefusalCase();
  } else {
    await stopRace("in-flight");
    await stopRace("settling");
  }
  receipt.passed = true;
  process.stdout.write(`iOS display ${mode} proof passed\n`);
} catch (error) {
  receipt.blockers.push(String(error));
  receipt.failedDisplayState = await displayState().catch(String);
  await evidence("blocked").catch((evidenceError) =>
    receipt.blockers.push(`Evidence capture: ${evidenceError}`)
  );
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
  receipt.ownedDaemonsRemoved = receipt.ownedDaemons.map((state) => ({
    removed: !existsSync(state),
    state: path.basename(state),
  }));
  receipt.simulatorInventory = {
    after: await simulatorInventory(),
    before: inventoryBefore,
  };
  assert.deepEqual(receipt.simulatorInventory.after, inventoryBefore);
  receipt.completedAt = new Date().toISOString();
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2)
  );
  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2)
  );
}
