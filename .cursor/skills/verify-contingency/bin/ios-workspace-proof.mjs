/* oxlint-disable eslint/no-await-in-loop -- One owned simulator and its Workspace journey run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { nativeComment } from "./android-ui.mjs";
import {
  selectedSimulatorResource,
  simulatorInventory,
} from "./ios-proof-resources.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

// A tap that focuses a field is recorded as its own forwarded action.
const focusTap = (entry) =>
  entry.kind === "activate" &&
  (entry.target?.role ?? "").endsWith("text-field");
const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const selected = process.env.CONTINGENCY_IOS_SELECTED;
const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
assert.ok(
  directory && selected && appPath,
  "Select the owned verification instance, selected UDID, and fixture."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl && instance.driverUrl);
const artifacts = path.join(
  root,
  process.env.CONTINGENCY_IOS_PROOF_ARTIFACTS ??
    ".cursor/skills/verify-contingency/artifacts/ios-workspace-runs"
);
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
const proofEntry = "public";
assert.equal(process.env.CONTINGENCY_IOS_WORKSPACE_INTERNAL, undefined);
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `ios-proof-${process.pid}-${sequence}`;
};
const journal = [];
const receipt = {
  actionDurations: [],
  blockers: [],
  coverage: {},
  entry: proofEntry,
  limits: {},
  resources: [],
  revealCandidates: [],
  settingsObservations: [],
  signIns: [],
  startedAt: new Date().toISOString(),
};
const control = async (...args) => {
  const began = performance.now();
  const startedAt = new Date().toISOString();
  const result = await execute(
    process.execPath,
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  journal.push({
    action: args[0],
    command: args
      .slice(1)
      .map((value) => (value === appPath ? "<fixture.app>" : value)),
    completedAt: new Date().toISOString(),
    durationMs: performance.now() - began,
    exitCode: 0,
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
    // Keep MCP refusals matchable the same way as internal RPC refusals.
    throw new Error(
      `${name} failed: ${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? error}`,
      { cause: error }
    );
  }
};
const call = async (command, source = "agent") => {
  const began = performance.now();
  const startedAt = new Date().toISOString();
  try {
    if (source === "agent") {
      return await tool("agent_device_workspace", { command, platform: "ios" });
    }
    return await iosRpc(instance.mcpUrl, "ios.workspace.command", {
      command,
      source,
    });
  } finally {
    if (
      ["input", "variable-input", "confirmation-answer"].includes(command._tag)
    ) {
      receipt.actionDurations.push({
        action: command.action?._tag ?? command._tag,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - began,
        operationId: command.operationId,
        sessionId: command.sessionId,
        source,
        startedAt,
      });
    }
  }
};
const read = (sessionId) => call({ _tag: "read", sessionId });
const observe = (sessionId) =>
  call({ _tag: "observe", image: false, sessionId });
const click = (name) => control("browser", "ios-click", "--name", name);
/** Allow one pending decision; each renders its own Allow. */
const allowDecision = (region) =>
  control("browser", "ios-click", "--name", "Allow", "--region", region);
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
const sessions = [];
const flowName = "ios-login";
const loginName = "Test Shopper";
const password = "fixture-password";
let selection;
const find = (current, role, name) => {
  const nodes =
    current.observation?.nodes.filter(
      (node) => node.role === role && node.name === name && !node.covered
    ) ?? [];
  assert.equal(nodes.length, 1, `Expected one ${role} ${name}`);
  return nodes[0];
};
let signInAttempt;
const agentAction = async (sessionId, role, name, text) => {
  if (signInAttempt) {
    signInAttempt.stage = name;
  }
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
  const supplied = await read(sessionId);
  const variable = supplied.variables.find(
    (entry) => entry.name === "PASSWORD"
  );
  assert.ok(variable);
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
  const before = await observe(sessionId);
  const field = find(before, "secure-text-field", "Password");
  await call({
    _tag: "input",
    action: { _tag: "variable", name: "PASSWORD", target: field.target },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
  await agentAction(sessionId, "button", "Sign in privately");
  await agentAction(sessionId, "button", "Open account");
  return agentAction(sessionId, "button", "Return to account");
};
const appName = "Contingency Public Login";
/**
 * Which app an observation shows. Workspace observations carry no app
 * identifier, so the tree names it: Settings' application node, the
 * fixture's own label, or Springboard's icon or card for the fixture.
 */
const shows = (current) => {
  const nodes = current.observation?.nodes ?? [];
  if (
    nodes.some(
      (node) => node.role === "application" && node.name === "Settings"
    )
  ) {
    return "settings";
  }
  if (
    nodes.some(
      (node) =>
        node.name === "Login fixture" ||
        node.name.startsWith("Signed in as ") ||
        node.name === "Account details"
    )
  ) {
    return "target";
  }
  return nodes.some(
    (node) => node.name === appName && node.role !== "application"
  )
    ? "springboard"
    : "other";
};
/** How Teaching names the rail's Home (`systemKeyDescription`). */
const systemKeyHome = "Go home";
const area = (node) => node.bounds.width * node.bounds.height;
/**
 * The uncovered node with this name to activate on Springboard: its icon, or
 * in the App Switcher its card. The switcher also gives the name to
 * containers that fill the screen; the card is the largest node within it.
 */
const named = (current, name) => {
  const nodes =
    current.observation?.nodes.filter(
      (node) =>
        node.name === name && node.role !== "application" && !node.covered
    ) ?? [];
  const { height, width } = current.observation;
  const [choice] = nodes
    .filter(
      (node) =>
        node.bounds !== undefined &&
        area(node) < width * height &&
        node.bounds.x >= 0 &&
        node.bounds.y >= 0 &&
        node.bounds.x + node.bounds.width <= width &&
        node.bounds.y + node.bounds.height <= height
    )
    .toSorted((a, b) => area(b) - area(a));
  receipt.revealCandidates.push(
    nodes.map(({ bounds, role }) => ({ bounds, chosen: false, role }))
  );
  assert.ok(choice, `Expected a node named ${name} to activate`);
  receipt.revealCandidates.at(-1)[nodes.indexOf(choice)].chosen = true;
  return { ...choice, observationId: current.observation.id };
};
// The observer follows the app in front (ADR 0083). Each completed product
// observation is the event; never wait on animation time.
/** Whether the Target App's icon, or its App Switcher card, is on screen. */
const iconShown = (current) =>
  current.observation?.nodes.some(
    (node) =>
      node.name === appName && node.role !== "application" && !node.covered
  ) ?? false;
const settingsDetour = async (sessionId, stage, tap, home, open, reveal) => {
  const started = performance.now();
  const record = async (kind, index, action) => {
    const at = new Date().toISOString();
    const began = performance.now();
    const result = await action();
    receipt.settingsObservations.push({
      at,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - began,
      elapsedMs: performance.now() - started,
      index,
      kind,
      observationId: result?.observation?.id ?? null,
      phase: result?.phase ?? null,
      shows: result?.observation ? shows(result) : null,
      stage,
    });
    return result;
  };
  const until = async (kind, app) => {
    for (let index = 1; index <= 40; index += 1) {
      const current = await record(kind, index, () => observe(sessionId));
      assert.equal(current.phase, "running", `${stage}: ${kind} paused`);
      assert.equal(current.refusal ?? null, null);
      if (shows(current) === app) {
        return current;
      }
    }
    return assert.fail(`${stage}: no ${app} observation in 40 attempts`);
  };
  await record("tap", 0, tap);
  const settings = await until("settings", "settings");
  await snapshot(`${stage}-settings-followed`);
  await record("home", 0, home);
  let springboard = await until("home", "springboard");
  // A fresh simulator puts the Target App on the next Home Screen page, where
  // its icon has no frame. Bring it within reach once (the user turns the
  // page; an agent opens the App Switcher), then wait for an observation that
  // shows it.
  if (!iconShown(springboard)) {
    assert.ok(reveal, `${stage}: ${appName} is not on the shown page`);
    await record("reveal", 0, reveal);
    for (let index = 1; !iconShown(springboard); index += 1) {
      assert.ok(index <= 40, `${stage}: ${appName} never came on screen`);
      springboard = await record("reveal", index, () => observe(sessionId));
      assert.equal(springboard.phase, "running", `${stage}: reveal paused`);
    }
  }
  await snapshot(`${stage}-home-followed`);
  await record("open", 0, () => open(named(springboard, appName)));
  const back = await until("return", "target");
  return { back, settings, springboard };
};
/**
 * Prepare a Dry Run or Run. Each one installs its Teaching Recording's build
 * (ADR 0085), so its App installation decision is allowed first.
 */
const prepareRun = async (sessionId) => {
  const prepared = await read(sessionId);
  const { pending } = prepared.preparation;
  if (pending.some((decision) => decision.kind === "app-installation")) {
    await allowDecision("App installation");
  }
  await click("Prepare selected simulator");
};
const railHome = () => click("iOS Home");
const agentKey = async (sessionId, key) => {
  const before = await observe(sessionId);
  return call({
    _tag: "input",
    action: { _tag: key },
    observationId: before.observation.id,
    operationId: operation(),
    sessionId,
  });
};
const agentHome = (sessionId) => agentKey(sessionId, "home");
const ownSessionResources = async () => [
  await selectedSimulatorResource(instance, selected),
];
const inventoryBefore = await simulatorInventory();

try {
  const listed = await tool("agent_device_sessions_list", { platform: "ios" });
  assert.ok(Array.isArray(listed), "Public MCP must list iOS sessions");
  receipt.coverage.publicListing = true;
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const discovered = devices.find((candidate) => candidate.udid === selected);
  assert.ok(discovered && ["26.5", "27.1"].includes(discovered.runtimeVersion));
  const { state: _state, ...device } = discovered;
  receipt.cell = {
    deviceType: device.deviceType,
    runtime: device.runtime,
    runtimeVersion: device.runtimeVersion,
  };
  selection = {
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
  // Selection limits are refused before any session or device command.
  const refusal = async (command, pattern) => {
    let message;
    try {
      await call(command);
    } catch (error) {
      message = String(error);
    }
    assert.ok(message, "Expected an explicit refusal");
    assert.match(message, pattern);
    return message
      .replaceAll(root, "<repo>")
      .replaceAll(appPath, "<fixture.app>")
      .replaceAll(selected, "<selected>")
      .replaceAll(/agent-ios-[0-9a-f]+/gu, "<session>")
      .slice(0, 600);
  };
  const probe = (probeDevice, kind = "teaching") => ({
    _tag: "start",
    flowName,
    kind,
    operationId: operation(),
    recordingId: null,
    selection: { ...selection, device: probeDevice },
  });
  receipt.limits.physicalDevice = await refusal(
    probe({
      kind: "physical",
      name: "Synthetic iPhone",
      udid: "00008030-001A2C3E0A88802E",
    }),
    /physical_device_unsupported/u
  );
  receipt.limits.osOutsideMatrix = {};
  for (const runtimeVersion of ["25.0", "28.0"]) {
    receipt.limits.osOutsideMatrix[runtimeVersion] = await refusal(
      probe({ ...device, runtimeVersion }),
      /os_unsupported/u
    );
  }
  const listedAfterProbes = await iosRpc(
    instance.mcpUrl,
    "ios.workspace.list",
    {}
  );
  assert.equal(
    listedAfterProbes.length,
    0,
    "Refused selections must not create sessions"
  );
  // Teaching starts through the actual Workspace setup controls.
  await control("browser", "goto", "--url", instance.mcpUrl);
  await control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Start an iOS session"
  );
  // The tile opens the Teach on iOS start card on the home.
  await control("browser", "wait", "--role", "form", "--name", "Teach on iOS");
  await fill("Flow name", flowName);
  // Device choice is a card named for the simulator; the name is unique to
  // this proof-owned UDID.
  const listedDevices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const selectedDevice = listedDevices.find((entry) => entry.udid === selected);
  assert.ok(selectedDevice, "The proof-owned simulator must be discovered");
  await control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    selectedDevice.name,
    "--partial",
    "true"
  );
  // The Target App is the fixture `.app` folder, uploaded through the card's
  // folder picker; its bundle identifier and build are read from it. The
  // button answers the file chooser it opens.
  await control(
    "browser",
    "set-input-files",
    "--role",
    "button",
    "--name",
    "Upload a simulator .app",
    "--path",
    appPath
  );
  await control(
    "browser",
    "wait",
    "--text",
    "dev.contingency.ioslogin · build 1 · installs with your consent",
    "--timeout-ms",
    "120000"
  );
  await control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Setup",
    "--partial",
    "true"
  );
  for (const [name, value] of [
    ["Starting screen element", "Login fixture"],
    ["Done when element", `Signed in as ${loginName}`],
  ]) {
    await fill(name, value);
  }
  // The click waits for the start's reply; the card then opens `?ios=<id>`.
  await click("Start teaching");
  const list = await iosRpc(instance.mcpUrl, "ios.workspace.list", {});
  const teaching = list.find((entry) => entry.flowName === flowName);
  assert.ok(teaching);
  sessions.push(teaching.id);
  await view(teaching.id);
  await click("Allow");
  receipt.coverage.appInstallationDecision = true;
  await click("Prepare selected simulator");
  receipt.resources.push(...(await ownSessionResources()));
  find(await read(teaching.id), "text", "Photos access: not determined");
  await snapshot("teaching-prepared");
  process.stdout.write("iOS Workspace preparation passed\n");
  await click("Start recording");
  await pick(teaching.id, "text-field", "Login name");
  // The keys are Forwarded Input, typed on the focused live display.
  await control("browser", "device-type", "--text", loginName);
  await pick(teaching.id, "secure-text-field", "Password");
  await click("Request Variable");
  await fill("PASSWORD", password);
  await click("Supply PASSWORD");
  await click("Enter PASSWORD");
  await pick(teaching.id, "button", "Sign in privately");
  // A comment attaches the element it is about (ADR 0088).
  await nativeComment(
    control,
    "Open account shows the signed-in details.",
    "Open account"
  );
  const teachingResources = await ownSessionResources();
  const teachingDetour = await settingsDetour(
    teaching.id,
    "teaching",
    () => pick(teaching.id, "button", "Open device settings"),
    railHome,
    (icon) => pick(teaching.id, icon.role, icon.name),
    () => control("browser", "ios-swipe", "--direction", "left")
  );
  assert.equal(teachingDetour.settings.captureState._tag, "recording");
  assert.equal(teachingDetour.springboard.captureState._tag, "recording");
  const teachingRecovered = teachingDetour.back;
  assert.equal(teachingRecovered.captureState._tag, "recording");
  find(teachingRecovered, "text", `Signed in as ${loginName}`);
  const teachingRecoveredResources = await ownSessionResources();
  assert.deepEqual(
    teachingRecoveredResources.map((resource) => resource.udid).toSorted(),
    teachingResources.map((resource) => resource.udid).toSorted()
  );
  find(teachingRecovered, "button", "Open account");
  receipt.coverage.teachingSettingsDetour = true;
  await snapshot("teaching-settings-returned");
  await pick(teaching.id, "button", "Open account");
  await pick(teaching.id, "button", "Return to account");
  await snapshot("teaching-outcome");
  await click("Stop recording");
  const stopped = await read(teaching.id);
  assert.equal(stopped.captureState._tag, "ready");
  receipt.coverage.teaching = true;
  // Close session is in the Agent Session picker, not the island.
  await control("browser", "native-close");
  const { recordingId } = stopped;
  const interval = JSON.parse(
    await readFile(
      path.join(
        instance.stateDir,
        "catalog",
        flowName,
        "recordings",
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
  const recorded = timeline.entries.filter((entry) => entry._tag === "action");
  assert.ok(
    recorded.some(
      (entry) => focusTap(entry) && entry.target?.name === "Login name"
    ),
    "The tap that focused Login name is missing."
  );
  // The Settings detour is taught too: it is kept apart from the journey.
  const detour = new Set([
    "Activate button Open device settings",
    systemKeyHome,
  ]);
  const taught = recorded.filter((entry) => !focusTap(entry));
  // Turning the Home Screen page to the Target App's icon is part of it.
  const detoured = taught.filter(
    (entry) =>
      detour.has(entry.description) ||
      entry.kind === "swipe" ||
      entry.target?.name === appName
  );
  assert.deepEqual(detoured.map((entry) => entry.description).slice(0, 2), [
    "Activate button Open device settings",
    systemKeyHome,
  ]);
  const actions = taught.filter((entry) => !detoured.includes(entry));
  assert.deepEqual(
    actions.map((entry) => entry.kind),
    ["fill", "variable", "activate", "activate", "activate"]
  );
  assert.deepEqual(
    actions.map((entry) => entry.description),
    [
      "Enter text in text-field Login name",
      `Enter Variable PASSWORD: ${password} in secure-text-field Password`,
      "Activate button Sign in privately",
      "Activate button Open account",
      "Activate button Return to account",
    ]
  );
  const comments = timeline.entries.filter(
    (entry) => entry._tag === "instruction"
  );
  assert.equal(comments.length, 1);
  assert.equal(comments[0].target, 'button "Open account"');
  assert.equal(comments[0].element?.platform, "ios");
  receipt.coverage.attachedComment = comments[0].target;
  // Forwarded typing has no exact readback; the private Variable stays unconfirmed.
  assert.equal(actions[1].inputConfirmation, "unconfirmed");
  assert.ok(actions.every((entry) => entry.before.ios && entry.after.ios));
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  const content = `---\nname: ${flowName}\ndescription: Sign in with test inputs, open account details, and return. Use for the iOS Workspace fixture.\ninputs:\n  - name: PASSWORD\n    description: Test account password\n---\n\n# Public login and account\n\n1. Enter ${loginName} in Login name. Done when: the field shows ${loginName}.\n2. Fill Password with {{PASSWORD}}. Readback is unavailable for the secure field. Done when: Sign in privately is visible.\n3. Activate Sign in privately. Done when: Signed in as ${loginName} is visible.\n4. Activate Open account. Done when: Account details is visible.\n5. Activate Return to account. Done when: Signed in as ${loginName} is visible.\n`;
  await tool("agent_flow_save", {
    claimOperationId: claim,
    files: [{ content, path: "flow.md" }],
    operationId: operation(),
    recordingId,
  });
  receipt.coverage.learning = true;
  process.stdout.write("iOS Teaching and Flow learning passed\n");
  // Existing data must survive later sessions on this selected device.
  // Installing the recording's build again can move the data container, so
  // the sentinel is found through the app each time, not by a stored path.
  const sentinel = async () => {
    const container = await execute("xcrun", [
      "simctl",
      "get_app_container",
      selected,
      selection.environment.bundleId,
      "data",
    ]);
    return path.join(
      container.stdout.trim(),
      "Documents/selected-data-proof.txt"
    );
  };
  await writeFile(
    await sentinel(),
    "selected simulator data survives sessions"
  );
  const { appPath: _installedPath, ...installedSelection } = selection;
  // The later Run declares a starting permission state Teaching never had.
  const permissions = [{ decision: "revoke", service: "photos" }];
  const repeatSignIns = Number(process.env.CONTINGENCY_IOS_SIGN_INS ?? 0);
  assert.ok(
    Number.isInteger(repeatSignIns) && repeatSignIns >= 0 && repeatSignIns <= 30
  );
  // Fresh product Dry Runs retain the taught requirements and restart only the Target App.
  for (let index = 1; index <= repeatSignIns; index += 1) {
    let repeated;
    const began = performance.now();
    const entry = {
      index,
      stage: "start",
      startedAt: new Date().toISOString(),
    };
    try {
      repeated = await call({
        _tag: "start",
        flowName,
        kind: "dry-run",
        operationId: operation(),
        recordingId,
        selection: installedSelection,
      });
      sessions.push(repeated.id);
      await view(repeated.id);
      entry.stage = "prepare";
      await prepareRun(repeated.id);
      entry.stage = "sign-in-journey";
      signInAttempt = entry;
      const current = await publicJourney(repeated.id);
      find(current, "text", `Signed in as ${loginName}`);
      entry.outcome = "passed";
    } catch (error) {
      entry.outcome = "failed";
      entry.error = String(error);
      await snapshot(`sign-in-${index}-blocked`).catch((evidenceError) => {
        entry.evidenceError = String(evidenceError);
      });
    } finally {
      signInAttempt = undefined;
      if (repeated) {
        await call(
          { _tag: "close", operationId: operation(), sessionId: repeated.id },
          "user"
        );
      }
      entry.completedAt = new Date().toISOString();
      entry.durationMs = performance.now() - began;
      receipt.signIns.push(entry);
      await writeFile(
        path.join(artifacts, "sign-ins.json"),
        JSON.stringify(receipt.signIns, null, 2)
      );
      process.stdout.write(
        `iOS repeated sign-in ${index}/${repeatSignIns}: ${entry.outcome}\n`
      );
    }
  }
  if (repeatSignIns > 0) {
    assert.equal(
      receipt.signIns.filter((entry) => entry.outcome === "failed").length,
      0,
      "Repeated sign-in failures are retained in sign-ins.json"
    );
  }
  for (const kind of ["dry-run", "run"]) {
    const started = await call({
      _tag: "start",
      flowName,
      kind,
      operationId: operation(),
      recordingId: kind === "dry-run" ? recordingId : null,
      selection:
        kind === "run"
          ? {
              ...installedSelection,
              environment: { ...installedSelection.environment, permissions },
            }
          : installedSelection,
    });
    sessions.push(started.id);
    await view(started.id);
    if (kind === "run") {
      const declared = await read(started.id);
      assert.deepEqual(declared.preparation.differences, [
        {
          field: "permissions",
          selected: JSON.stringify(permissions),
          taught: "[]",
        },
      ]);
      assert.deepEqual(
        declared.preparation.pending
          .map((decision) => decision.kind)
          .filter((decision) => decision !== "app-installation"),
        ["run-environment-permission"]
      );
      await snapshot("permission-states-declared");
      await allowDecision("Run Environment Permission");
    }
    await prepareRun(started.id);
    receipt.resources.push(...(await ownSessionResources()));
    const prepared = await read(started.id);
    assert.equal(prepared.refusal ?? null, null);
    find(
      prepared,
      "text",
      kind === "run" ? "Photos access: denied" : "Photos access: not determined"
    );
    if (kind === "run") {
      assert.equal(
        receipt.settingsObservations.filter((entry) => entry.stage === "run")
          .length,
        0
      );
      receipt.coverage.declaredPermissionState = {
        appliedBeforeLaunch: "Photos access: denied",
        differences: prepared.preparation.differences,
        observationId: prepared.observation.id,
        settingsVisited: false,
      };
      await snapshot("permission-state-applied");
    }
    assert.equal(
      await readFile(await sentinel(), "utf-8"),
      "selected simulator data survives sessions"
    );
    receipt.coverage.existingAppData = true;
    let current = await publicJourney(started.id);
    if (kind === "run") {
      const ids = [];
      for (const allow of [false, true]) {
        const before = await observe(started.id);
        const target = find(before, "button", "Open account");
        const command = {
          _tag: "input",
          action: { _tag: "activate", target: target.target },
          irreversible: true,
          observationId: before.observation.id,
          operationId: operation(),
          sessionId: started.id,
        };
        const pending = await call(command);
        assert.equal(pending.boundary.reason, "confirmation");
        assert.equal(pending.phase, "running");
        const decisionId = pending.pendingDecision.pendingDecisionId;
        ids.push(decisionId);
        await snapshot(`confirmation-${allow ? "allow" : "refuse"}`);
        await click(allow ? "Allow" : "Refuse");
        current = await observe(started.id);
        assert.equal(current.pendingDecision, null);
        find(
          current,
          "text",
          allow ? "Account details" : `Signed in as ${loginName}`
        );
        // The original operation's receipt cannot dispatch a second attempt.
        await call(command);
        if (allow) {
          current = await agentAction(
            started.id,
            "button",
            "Return to account"
          );
        }
      }
      assert.notEqual(ids[0], ids[1]);
      receipt.coverage.confirmation = {
        allowOnce: true,
        distinctDecisions: ids,
        refuse: true,
      };
      current = await agentAction(
        started.id,
        "button",
        "Request notifications permission"
      );
      assert.equal(current.phase, "running");
      await snapshot("system-alert");
      const alertButton = current.observation.nodes.find(
        (node) =>
          node.role === "button" && node.name === "Allow" && !node.covered
      );
      assert.ok(alertButton, "System alert must expose Allow to the agent");
      current = await call({
        _tag: "input",
        action: { _tag: "activate", target: alertButton.target },
        observationId: current.observation.id,
        operationId: operation(),
        sessionId: started.id,
      });
      assert.equal(current.phase, "running");
      find(current, "text", `Signed in as ${loginName}`);
      receipt.coverage.systemAlert = true;
      await snapshot("system-alert-answered");
      const resourcesBeforeSettings = await ownSessionResources();
      const beforeSettings = await observe(started.id);
      find(beforeSettings, "text", `Signed in as ${loginName}`);
      // Settings comes forward and is observed; Home and the app's icon
      // bring the Target App back with its state.
      const runDetour = await settingsDetour(
        started.id,
        "run",
        () => agentAction(started.id, "button", "Open device settings"),
        () => agentHome(started.id),
        // The card shares its role and name with the switcher's containers,
        // so the agent names it by target in the observation it chose from.
        (icon) =>
          call({
            _tag: "input",
            action: { _tag: "activate", target: icon.target },
            observationId: icon.observationId,
            operationId: operation(),
            sessionId: started.id,
          }),
        // An agent cannot turn Home Screen pages; the App Switcher shows the
        // Target App it just left.
        () => agentKey(started.id, "app-switcher")
      );
      current = runDetour.back;
      assert.equal(current.refusal ?? null, null);
      find(current, "text", `Signed in as ${loginName}`);
      find(current, "button", "Open account");
      const resourcesAfterSettings = await ownSessionResources();
      assert.deepEqual(
        resourcesAfterSettings.map((resource) => resource.udid).toSorted(),
        resourcesBeforeSettings.map((resource) => resource.udid).toSorted()
      );
      await snapshot("settings-returned");
      current = await agentAction(started.id, "button", "Open account");
      find(current, "text", "Account details");
      current = await agentAction(started.id, "button", "Return to account");
      find(current, "text", `Signed in as ${loginName}`);
      receipt.coverage.settingsDetour = {
        followed: ["settings", "springboard", "target"],
        journeyContinued: true,
        paused: false,
        sameSimulator: true,
        statePreserved: true,
      };
    }
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
        path.join(instance.stateDir, "catalog", flowName, "flow.md"),
        "utf-8"
      );
      assert.match(skill, /"platform":"ios"/u);
      const verification = await readFile(
        path.join(instance.stateDir, "catalog", flowName, "flow.md"),
        "utf-8"
      );
      assert.match(verification, /"platform":"ios"/u);
      receipt.coverage.verificationAndPurge = true;
      await snapshot("verified-purged");
    }
    process.stdout.write(`iOS ${kind} passed\n`);
  }
  // A separate limits Run keeps refusals out of the successful journey Run.
  const limits = await call({
    _tag: "start",
    flowName,
    kind: "run",
    operationId: operation(),
    recordingId: null,
    selection: installedSelection,
  });
  sessions.push(limits.id);
  await view(limits.id);
  await prepareRun(limits.id);
  receipt.resources.push(...(await ownSessionResources()));
  receipt.limits.sameDeviceBound = await refusal(
    probe(device, "run"),
    /already bound/u
  );
  receipt.limits.multipleBoundDevices = await refusal(
    probe(
      {
        ...device,
        name: "Synthetic iPhone",
        udid: "00000000-0000-4000-8000-000000000001",
      },
      "run"
    ),
    /binds one device at a time/u
  );
  let limitObservation = await observe(limits.id);
  receipt.limits.rawCoordinates = await refusal(
    {
      _tag: "input",
      action: { _tag: "coordinate", x: 1, y: 2 },
      observationId: limitObservation.observation.id,
      operationId: operation(),
      sessionId: limits.id,
    },
    /Expected|Invalid parameters/u
  );
  limitObservation = await observe(limits.id);
  find(limitObservation, "text", "Login fixture");
  receipt.limits.back = await refusal(
    {
      _tag: "input",
      action: { _tag: "back" },
      observationId: limitObservation.observation.id,
      operationId: operation(),
      sessionId: limits.id,
    },
    /ios_workspace_refused.*no system Back/u
  );
  await snapshot("limit-back");
  await call(
    { _tag: "close", operationId: operation(), sessionId: limits.id },
    "user"
  );
  receipt.coverage.documentedLimits = true;
  process.stdout.write("iOS documented limits passed\n");
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
  const finalDevices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const finalSelected = finalDevices.find((entry) => entry.udid === selected);
  assert.ok(
    finalSelected,
    "Product must retain the selected simulator after closing sessions"
  );
  assert.equal(
    finalSelected.state,
    "Booted",
    "Product must leave the selected simulator running"
  );
  receipt.coverage.selectedSimulatorRemainsRunning = true;
  receipt.simulatorInventory = {
    after: await simulatorInventory(),
    before: inventoryBefore,
    selectedUdid: selected,
  };
  assert.deepEqual(
    receipt.simulatorInventory.after,
    inventoryBefore,
    "Product created, deleted, or changed a simulator"
  );
  receipt.coverage.noSimulatorCreationOrDeletion = true;
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
