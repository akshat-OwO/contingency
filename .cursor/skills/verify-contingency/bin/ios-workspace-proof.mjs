/* oxlint-disable eslint/no-await-in-loop -- One owned simulator and its Workspace journey run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  selectedSimulatorResource,
  simulatorInventory,
} from "./ios-proof-resources.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

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
// Before listing, agent commands use internal RPC and public MCP must refuse iOS.
const proofEntry = process.env.CONTINGENCY_IOS_PROOF_ENTRY ?? "public";
assert.ok(["internal", "public"].includes(proofEntry));
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
  settingsObservations: [],
  startedAt: new Date().toISOString(),
};
const control = async (...args) => {
  const began = performance.now();
  const startedAt = new Date().toISOString();
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
    if (proofEntry === "public" && source === "agent") {
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
const flowSkillName = "ios-login";
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
// Each completed product observation is the event; never wait on animation time.
const settingsRefusal = async (sessionId, stage, tap) => {
  const started = performance.now();
  const record = async (kind, index, action) => {
    const at = new Date().toISOString();
    const began = performance.now();
    try {
      const result = await action();
      receipt.settingsObservations.push({
        at,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - began,
        elapsedMs: performance.now() - started,
        index,
        kind,
        observationId: result?.observation?.id ?? null,
        outcome: kind === "tap" && !result?.observation ? "accepted" : "tree",
        stage,
      });
      return false;
    } catch (error) {
      const refused = /foreign_app_foreground/u.test(
        `${error.stderr ?? ""}${error.stdout ?? ""}${error}`
      );
      receipt.settingsObservations.push({
        at,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - began,
        elapsedMs: performance.now() - started,
        index,
        kind,
        outcome: refused ? "foreign_app_foreground" : "error",
        stage,
      });
      if (!refused) {
        throw error;
      }
      return true;
    }
  };
  const tapRefused = await record("tap", 0, tap);
  let refused = false;
  for (let index = 1; index <= 40; index += 1) {
    refused = await record("observe", index, () => observe(sessionId));
    if (refused) {
      break;
    }
  }
  assert.ok(refused, `${stage}: no foreign_app_foreground in 40 observations`);
  for (let index = 1; index <= 3; index += 1) {
    assert.ok(
      await record("persistence", index, () => observe(sessionId)),
      `${stage}: foreign-app refusal must persist`
    );
  }
  return { tapRefused };
};
const ownSessionResources = async () => [
  await selectedSimulatorResource(instance, selected),
];
const inventoryBefore = await simulatorInventory();

try {
  if (proofEntry === "public") {
    const listed = await tool("agent_device_sessions_list", {
      platform: "ios",
    });
    assert.ok(Array.isArray(listed), "Public MCP must list iOS sessions");
    receipt.coverage.publicListing = true;
  } else {
    await assert.rejects(
      tool("agent_device_sessions_list", { platform: "ios" }),
      /ios_support_matrix_unproven/u
    );
    receipt.coverage.publicMcpGate = true;
  }
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const device = devices.find((candidate) => candidate.udid === selected);
  assert.ok(device && ["26.5", "27.1"].includes(device.runtimeVersion));
  receipt.cell = {
    deviceType: device.deviceType,
    runtime: device.runtime,
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
      .replaceAll(selected, "<selected>")
      .replaceAll(/agent-ios-[0-9a-f]+/gu, "<session>")
      .slice(0, 600);
  };
  const probe = (probeDevice, kind = "teaching") => ({
    _tag: "start",
    flowSkillName,
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
    selected
  );
  for (const [name, value] of [
    ["Simulator app path", appPath],
    ["Bundle identifier", selection.environment.bundleId],
    ["App build", "1"],
    ["Starting screen element", "Login fixture"],
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
  await click("Allow");
  receipt.coverage.appInstallationDecision = true;
  await click("Prepare selected simulator");
  receipt.resources.push(...(await ownSessionResources()));
  find(await read(teaching.id), "text", "Photos access: not determined");
  await snapshot("teaching-prepared");
  process.stdout.write("iOS Workspace preparation passed\n");
  await click("Start recording");
  await pick(teaching.id, "text-field", "Login name");
  await fill("Text for Login name", loginName);
  await click("Type");
  await pick(teaching.id, "secure-text-field", "Password");
  await click("Request Variable");
  await fill("PASSWORD", password);
  await click("Supply PASSWORD");
  await click("Enter PASSWORD");
  await pick(teaching.id, "button", "Sign in privately");
  const teachingResources = await ownSessionResources();
  const { tapRefused: teachingTapRefused } = await settingsRefusal(
    teaching.id,
    "teaching",
    () => pick(teaching.id, "button", "Open device settings")
  );
  const teachingRefused = await read(teaching.id);
  assert.equal(teachingRefused.phase, "paused");
  assert.equal(teachingRefused.refusal.code, "foreign_app_foreground");
  assert.equal(teachingRefused.captureState._tag, "recording");
  await snapshot("teaching-settings-refused");
  await click("Return to Target App");
  const teachingRecovered = await observe(teaching.id);
  assert.equal(teachingRecovered.phase, "running");
  assert.equal(teachingRecovered.refusal, null);
  assert.equal(teachingRecovered.captureState._tag, "recording");
  find(teachingRecovered, "text", `Signed in as ${loginName}`);
  const teachingRecoveredResources = await ownSessionResources();
  assert.deepEqual(
    teachingRecoveredResources.map((resource) => resource.udid).toSorted(),
    teachingResources.map((resource) => resource.udid).toSorted()
  );
  find(teachingRecovered, "button", "Open account");
  receipt.coverage.teachingSettingsRecovery = true;
  await snapshot("teaching-settings-recovered");
  await pick(teaching.id, "button", "Open account");
  await pick(teaching.id, "button", "Return to account");
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
    [
      "fill",
      "variable",
      "activate",
      ...(teachingTapRefused ? [] : ["activate"]),
      "activate",
      "activate",
    ]
  );
  assert.deepEqual(
    actions.map((entry) => entry.description),
    [
      "Enter public fixture text in text-field Login name",
      `Enter Variable PASSWORD: ${password} in secure-text-field Password`,
      "Activate button Sign in privately",
      ...(teachingTapRefused ? [] : ["Activate button Open device settings"]),
      "Activate button Open account",
      "Activate button Return to account",
    ]
  );
  assert.equal(actions[0].inputConfirmation, "confirmed");
  assert.equal(actions[1].inputConfirmation, "unconfirmed");
  assert.ok(actions.every((entry) => entry.before.ios && entry.after.ios));
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  const content = `---\nname: ${flowSkillName}\ndescription: Sign in with test inputs, open account details, and return. Use for the iOS Workspace fixture.\ninputs:\n  - name: PASSWORD\n    description: Test account password\n---\n\n# Public login and account\n\n1. Enter ${loginName} in Login name. Done when: the field shows ${loginName}.\n2. Fill Password with {{PASSWORD}}. Readback is unavailable for the secure field. Done when: Sign in privately is visible.\n3. Activate Sign in privately. Done when: Signed in as ${loginName} is visible.\n4. Activate Open account. Done when: Account details is visible.\n5. Activate Return to account. Done when: Signed in as ${loginName} is visible.\n`;
  await tool("agent_flow_skill_save", {
    claimOperationId: claim,
    files: [{ content, path: "SKILL.md" }],
    operationId: operation(),
    recordingId,
  });
  receipt.coverage.learning = true;
  process.stdout.write("iOS Teaching and Flow Skill learning passed\n");
  // Existing data must survive later sessions on this selected device.
  const dataContainer = await execute("xcrun", [
    "simctl",
    "get_app_container",
    selected,
    selection.environment.bundleId,
    "data",
  ]);
  const sentinel = path.join(
    dataContainer.stdout.trim(),
    "Documents/selected-data-proof.txt"
  );
  await writeFile(sentinel, "selected simulator data survives sessions");
  const { appPath: _installedPath, ...installedSelection } = selection;
  // The later Run declares a starting permission state Teaching never had.
  const permissions = [{ decision: "revoke", service: "photos" }];
  for (const kind of ["dry-run", "run"]) {
    const started = await call({
      _tag: "start",
      flowSkillName,
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
        declared.preparation.pending.map((decision) => decision.kind),
        ["run-environment-permission"]
      );
      await snapshot("permission-states-declared");
      await click("Allow");
    }
    await click("Prepare selected simulator");
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
      await readFile(sentinel, "utf-8"),
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
      await settingsRefusal(started.id, "run", () =>
        agentAction(started.id, "button", "Open device settings")
      );
      const refused = await read(started.id);
      assert.equal(refused.phase, "paused");
      assert.equal(refused.observation, null);
      assert.deepEqual(refused.refusal, {
        code: "foreign_app_foreground",
        recovery: "return-to-target-app",
      });
      await snapshot("settings-refused");
      await click("Return to Target App");
      current = await observe(started.id);
      assert.equal(current.phase, "running");
      assert.equal(current.refusal, null);
      find(current, "text", `Signed in as ${loginName}`);
      find(current, "button", "Open account");
      const resourcesAfterSettings = await ownSessionResources();
      assert.deepEqual(
        resourcesAfterSettings.map((resource) => resource.udid).toSorted(),
        resourcesBeforeSettings.map((resource) => resource.udid).toSorted()
      );
      await snapshot("settings-recovered");
      current = await agentAction(started.id, "button", "Open account");
      find(current, "text", "Account details");
      current = await agentAction(started.id, "button", "Return to account");
      find(current, "text", `Signed in as ${loginName}`);
      receipt.coverage.settingsRecovery = {
        code: refused.refusal.code,
        journeyContinued: true,
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
  // A separate limits Run keeps refusals out of the successful journey Run.
  const limits = await call({
    _tag: "start",
    flowSkillName,
    kind: "run",
    operationId: operation(),
    recordingId: null,
    selection: installedSelection,
  });
  sessions.push(limits.id);
  await view(limits.id);
  await click("Prepare selected simulator");
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
    /capability_missing/u
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
