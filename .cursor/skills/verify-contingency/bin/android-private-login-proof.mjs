/* oxlint-disable eslint/no-await-in-loop -- A selected device and Workspace gestures run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { androidIdle, androidPick, openAndroidSheet } from "./android-ui.mjs";

const directory = process.env.CONTINGENCY_VERIFY_DIR;
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
assert.ok(
  directory && serial,
  "Select an authorized device and isolated verification instance."
);
assert.equal(process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL, "authorized");
const physical = Boolean(process.env.CONTINGENCY_ANDROID_MODEL);
const feature = physical
  ? "android-private-login-physical"
  : "android-private-login";
const root = path.resolve(import.meta.dirname, "../../../..");
const skillRoot = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(skillRoot, "artifacts", feature);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const execute = promisify(execFile);
const journal = [];
const sentinel = `Login-${randomUUID()}-Z9!`;
const markers = [
  sentinel,
  Buffer.from(sentinel).toString("base64"),
  encodeURIComponent(sentinel),
];
const safe = (value) => {
  const text = JSON.stringify(value);
  assert.ok(
    !markers.some((marker) => text.includes(marker)),
    "Private sentinel escaped into retained evidence."
  );
  return text;
};
const run = async (file, args, options = {}) => {
  const result = await execute(file, args, {
    cwd: root,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  journal.push({
    args: [file, ...args],
    stderr: safe(result.stderr),
    stdout: safe(result.stdout),
  });
  return result.stdout;
};
const controlPath = path.join(import.meta.dirname, "control-contingency");
const control = (...args) => run("nub", [controlPath, ...args]);
const adb = (...args) => run("adb", ["-s", serial, ...args]);
let instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `${feature}-${process.pid}-${sequence}`;
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
    journal.push({
      refused: safe(String(error.stderr || error.stdout || error)),
      tool: name,
    });
    throw error;
  }
};
const command = (input) =>
  tool("agent_device_workspace", { command: input, platform: "android" });
const read = (sessionId) => command({ _tag: "read", sessionId });
const observe = (sessionId) =>
  command({ _tag: "observe", image: false, sessionId });
const refusal = async (input, expected) => {
  try {
    await command(input);
  } catch (error) {
    assert.match(safe(String(error.stderr || error.stdout || error)), expected);
    return;
  }
  assert.fail("Expected an Android refusal.");
};
const click = (name) =>
  control("browser", "click", "--role", "button", "--name", name);
const wait = (name, role = "button") =>
  control(
    "browser",
    "wait",
    "--role",
    role,
    "--name",
    name,
    "--timeout-ms",
    "90000"
  );
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
const select = (name, value) =>
  control(
    "browser",
    "select",
    "--role",
    "combobox",
    "--name",
    name,
    "--value",
    value
  );
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
// This is the same driver's fill gesture as control-contingency browser fill.
// Keep the generated value off command lines and out of the command journal.
const supply = async (name) => {
  const response = await fetch(instance.driverUrl, {
    body: JSON.stringify({
      action: "fill",
      flags: { name, role: "textbox", value: sentinel },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const result = await response.json();
  assert.equal(result.ok, true, safe(result));
  journal.push({
    action: "Workspace private field fill",
    name,
    value: "withheld",
  });
  await click(`Supply ${name}`);
  await androidIdle(control);
};
const view = async (sessionId) => {
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${sessionId}`
  );
  await wait("Workspace dock", "region");
  await androidIdle(control);
};
const prepare = async (sessionId) => {
  await view(sessionId);
  if (physical) {
    await control(
      "browser",
      "android-allow-request",
      "--name",
      "Clear Target App data"
    );
  }
  await click(
    physical ? "Prepare selected device" : "Prepare selected emulator"
  );
  await androidIdle(control);
  const prepared = await read(sessionId);
  assert.equal(
    prepared.phase,
    "running",
    prepared.error ?? "Device preparation failed."
  );
};
const appId = "dev.contingency.physicalfixture";
const flowSkillName = `${feature}-${process.pid}`;
const selection = {
  device: {
    api: 36,
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial,
    ...(physical
      ? { kind: "physical", model: process.env.CONTINGENCY_ANDROID_MODEL }
      : { avd: process.env.CONTINGENCY_ANDROID_AVD }),
  },
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId,
    startingState: "text Private login fixture is visible",
  },
  helperConsent: "install",
  outcomes: [{ name: "Signed in privately", role: "text" }],
  privateHelperConsent: "install",
  privateInput: true,
  setup: {
    activity: `${appId}/.LoginActivity`,
    conditions: [{ name: "Private login fixture", role: "text" }],
    kind: physical ? "clear-app-data" : "restart-activity",
  },
};
assert.ok(
  Object.values(selection.device).every((value) => value !== undefined)
);
const helper = "com.callstack.agentdevice.snapshothelper";
const privateHelper = "dev.contingency.privatetext";
const baseline = {
  forwards: await adb("forward", "--list"),
  ime: await adb("shell", "settings", "get", "secure", "default_input_method"),
  packages: {},
};
for (const name of [appId, helper, privateHelper]) {
  const installed = await adb("shell", `pm path ${name} || true`);
  baseline.packages[name] = installed.trim();
}
assert.equal(
  baseline.packages[appId],
  "",
  "Do not replace a preexisting fixture installation."
);
const temporaryEntries = await readdir(tmpdir());
const runtimeBaseline = new Set(
  temporaryEntries.filter((name) =>
    name.startsWith("contingency-android-runtime-")
  )
);
const hook = path.join(directory, `${feature}-audit.mjs`);
const audit = path.join(directory, `${feature}-arguments.jsonl`);
await writeFile(
  hook,
  `import cp from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { promisify } from 'node:util';\nfor (const method of ['execFile','spawn']) { const original = cp[method]; cp[method] = function(file, args, ...rest) { appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ pid: process.pid, file, args: Array.isArray(args) ? args : [] })+'\\n'); return original.call(this, file, args, ...rest); }; if (method === 'execFile') cp[method][promisify.custom] = (file, args, options) => new Promise((resolve, reject) => cp[method](file, args, options, (error, stdout, stderr) => error ? reject(Object.assign(error, {stdout, stderr})) : resolve({stdout, stderr}))); }\nsyncBuiltinESMExports();\n`,
  { mode: 0o600 }
);
const receipt = {
  blockers: [],
  cleanup: {},
  coverage: {},
  device: selection.device,
  feature,
};
const sessions = [];
let mcpOwned = false;
const scan = async () => {
  let files = 0;
  const visit = async (base) => {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const file = path.join(base, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && !file.endsWith(".apk")) {
        const bytes = await readFile(file);
        safe(bytes.toString());
        files += 1;
      }
    }
  };
  await visit(directory);
  await visit(artifacts);
  for (const name of await readdir(tmpdir())) {
    if (
      name.startsWith("contingency-android-runtime-") &&
      !runtimeBaseline.has(name)
    ) {
      await visit(path.join(tmpdir(), name));
    }
  }
  const logcat = await execute(
    "adb",
    ["-s", serial, "logcat", "-d", "-t", "20000"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  safe(logcat.stdout);
  safe(logcat.stderr);
  const argumentsText = await readFile(audit, "utf-8");
  safe(argumentsText);
  const commands = argumentsText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const adbCommands = commands.filter(
    (entry) => path.basename(entry.file) === "adb"
  );
  assert.ok(
    adbCommands.some((entry) =>
      entry.args.join(" ").includes(`${privateHelper}/.PrivateText`)
    ),
    "Audit must observe private helper instrumentation."
  );
  assert.ok(
    adbCommands.some(
      (entry) =>
        entry.args.join(" ").includes("instrument") &&
        entry.args.join(" ").includes(helper)
    ),
    "Audit must include stock agent-device snapshot instrumentation."
  );
  receipt.privacy = {
    adbCommands: adbCommands.length,
    encodedSentinelContained: false,
    inspectedFiles: files,
    logcatChecked: true,
    sentinelContained: false,
  };
};
try {
  const apk = path.join(
    skillRoot,
    "artifacts/android-physical/build-login/fixture.apk"
  );
  receipt.fixtureSha256 = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  await adb("install", apk);
  await run("nub", [controlPath, "mcp", "start"], {
    env: { ...process.env, NODE_OPTIONS: `--import=${hook}` },
  });
  mcpOwned = true;
  instance = JSON.parse(
    await readFile(path.join(directory, "instance.json"), "utf-8")
  );
  receipt.resources = {
    brokerPort: instance.brokerPort,
    mcpPid: instance.mcpPid,
    mcpPort: instance.mcpPort,
    mcpServerPid: instance.mcpServerPid,
    startedAt: new Date().toISOString(),
  };
  // Agent-held setup supply is outside the recording and ends at handoff.
  const setup = await command({
    _tag: "start",
    agentSetup: true,
    flowSkillName,
    kind: "teaching",
    operationId: operation(),
    recordingId: null,
    selection,
  });
  sessions.push(setup.id);
  await prepare(setup.id);
  await command({
    _tag: "variable-request",
    name: "SETUP_PASSWORD",
    operationId: operation(),
    purpose: "Prepare private login",
    replace: false,
    sessionId: setup.id,
  });
  await wait("SETUP_PASSWORD", "textbox");
  await supply("SETUP_PASSWORD");
  let current = await observe(setup.id);
  const password = current.observation.nodes.find((node) => node.password);
  assert.ok(
    password,
    "The private password field must be discoverable by reference."
  );
  await command({
    _tag: "input",
    action: {
      _tag: "variable",
      name: "SETUP_PASSWORD",
      target: password.target,
    },
    observationId: current.observation.id,
    operationId: operation(),
    sessionId: setup.id,
  });
  await scan();
  await command({
    _tag: "setup-handoff",
    operationId: operation(),
    sessionId: setup.id,
  });
  const handedOff = await read(setup.id);
  assert.deepEqual(handedOff.variables, []);
  await refusal(
    {
      _tag: "input",
      action: {
        _tag: "variable",
        name: "SETUP_PASSWORD",
        target: password.target,
      },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: setup.id,
    },
    /current controller/u
  );
  await snapshot("setup-handoff");
  await click("Close session");
  await control("browser", "wait", "--text", "Closed", "--timeout-ms", "90000");
  receipt.coverage.setupVariables = true;
  process.stdout.write("Setup Variables passed\n");
  // Open Teaching through the real setup sheet and use the dock's Variable picker.
  await control("browser", "goto", "--url", instance.mcpUrl);
  await openAndroidSheet(control, selection, flowSkillName, snapshot);
  const listed = await tool("agent_device_sessions_list", {
    platform: "android",
  });
  const teaching = listed.find(
    (session) =>
      session.flowSkillName === flowSkillName && session.phase !== "closed"
  );
  assert.ok(teaching);
  sessions.push(teaching.id);
  await prepare(teaching.id);
  await click("Start recording");
  await androidIdle(control);
  current = await observe(teaching.id);
  const field = current.observation.nodes.find((node) => node.password);
  assert.ok(field);
  await androidPick(control, teaching.id, field.role, field.name);
  await fill("Variable name", "PASSWORD");
  await click("Request Variable");
  await androidIdle(control);
  await supply("PASSWORD");
  await select("Variable", "PASSWORD");
  await click("Enter Variable");
  await androidIdle(control);
  await snapshot("teaching-private-fill");
  await scan();
  await androidPick(control, teaching.id, "button", "Sign in privately");
  await click("Stop recording");
  await androidIdle(control);
  const stopped = await read(teaching.id);
  assert.equal(stopped.captureState._tag, "ready");
  await snapshot("teaching-stopped");
  await click("Close session");
  const { recordingId } = stopped;
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
  await writeFile(path.join(artifacts, "timeline.json"), safe(timeline));
  const actions = timeline.entries.filter((event) => event._tag === "action");
  assert.equal(actions.filter((event) => event.kind === "variable").length, 1);
  assert.ok(
    actions.some((event) => event.description.includes("{{PASSWORD}}"))
  );
  assert.equal(actions.filter((event) => event.kind === "activate").length, 1);
  const content = `---\nname: ${flowSkillName}\ndescription: Sign in using a private password. Use when checking the private login fixture.\ninputs:\n  - password\n---\n\n# Sign in privately\n\n1. Enter {{password}} in the private password field. Done when: the password field stays masked.\n2. Activate Sign in privately. Done when: Signed in privately is visible.\n`;
  await tool("agent_flow_skill_save", {
    claimOperationId: claim,
    files: [{ content, path: "SKILL.md" }],
    operationId: operation(),
    recordingId,
  });
  receipt.coverage.teachingAndLearning = true;
  process.stdout.write("Teaching and learning passed\n");
  const agentLogin = async (kind, secure = false) => {
    const started = await command({
      _tag: "start",
      flowSkillName,
      kind,
      operationId: operation(),
      recordingId: kind === "dry-run" ? recordingId : null,
      selection,
    });
    sessions.push(started.id);
    await prepare(started.id);
    current = await observe(started.id);
    const { target } = current.observation.nodes.find((node) => node.password);
    await refusal(
      {
        _tag: "input",
        action: { _tag: "variable", name: "PASSWORD", target },
        observationId: "stale",
        operationId: operation(),
        sessionId: started.id,
      },
      /stale/u
    );
    await refusal(
      {
        _tag: "input",
        action: {
          _tag: "variable",
          name: "PASSWORD",
          target: current.observation.nodes.find(
            (node) => node.name === "Sign in privately"
          ).target,
        },
        observationId: current.observation.id,
        operationId: operation(),
        sessionId: started.id,
      },
      /Password fields require a Variable/u
    );
    await refusal(
      {
        _tag: "input",
        action: { _tag: "variable", name: "PASSWORD", target },
        observationId: current.observation.id,
        operationId: operation(),
        sessionId: started.id,
      },
      /supply it in Workspace/u
    );
    await supply("PASSWORD");
    current = await observe(started.id);
    const input = {
      _tag: "input",
      action: {
        _tag: "variable",
        name: "PASSWORD",
        target: current.observation.nodes.find((node) => node.password).target,
      },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: started.id,
    };
    await command(input);
    await command(input);
    current = await observe(started.id);
    const button = current.observation.nodes.find(
      (node) =>
        node.name ===
        (secure ? "Show secure login window" : "Sign in privately")
    );
    await command({
      _tag: "input",
      action: { _tag: "activate", target: button.target },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: started.id,
    });
    current = await observe(started.id);
    assert.ok(
      current.observation.nodes.some(
        (node) => node.name === "Signed in privately"
      )
    );
    await scan();
    const finished = await command({
      _tag: "complete",
      assessment: {
        explanation: "Signed in privately is visible",
        observationId: current.observation.id,
        outcome: "working",
      },
      operationId: operation(),
      sessionId: started.id,
    });
    assert.equal(finished.assessment.outcome, "working");
    await snapshot(`${kind}-passed`);
    if (kind === "dry-run") {
      await click("Verify flow");
      await control(
        "browser",
        "wait",
        "--text",
        "Recording deleted",
        "--timeout-ms",
        "90000"
      );
      const verified = await read(started.id);
      assert.equal(verified.cleanup._tag, "purged");
    }
    return finished;
  };
  await agentLogin("dry-run");
  receipt.coverage.dryRunAndVerification = true;
  process.stdout.write("Dry Run and verification passed\n");
  await agentLogin("run");
  receipt.coverage.laterRun = true;
  process.stdout.write("Later Run passed\n");
  // The fixture exposes a secure starting window solely for this refusal probe.
  const secure = await command({
    _tag: "start",
    flowSkillName,
    kind: "run",
    operationId: operation(),
    recordingId: null,
    selection,
  });
  sessions.push(secure.id);
  await prepare(secure.id);
  const beforeSecure = await observe(secure.id);
  await adb("shell", "am", "force-stop", appId);
  await adb(
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    `${appId}/.LoginActivity`,
    "--ez",
    "secure",
    "true"
  );
  await refusal(
    { _tag: "observe", image: false, sessionId: secure.id },
    /Secure window, not visible/u
  );
  const paused = await read(secure.id);
  assert.equal(paused.phase, "paused");
  assert.match(paused.error, /Secure window, not visible/u);
  await snapshot("secure-window");
  const inconclusive = await command({
    _tag: "complete",
    assessment: {
      explanation: "The secure window hides the outcome",
      observationId: beforeSecure.observation.id,
      outcome: "working",
    },
    operationId: operation(),
    sessionId: secure.id,
  });
  assert.equal(inconclusive.assessment.outcome, "inconclusive");
  receipt.coverage.secureWindow = true;
  await scan();
} catch (error) {
  receipt.blockers.push(safe(String(error.stderr || error.stdout || error)));
  process.exitCode = 1;
} finally {
  for (const sessionId of sessions) {
    try {
      const retained = await read(sessionId);
      if (["closed", "completed"].includes(retained.phase)) {
        continue;
      }
      await view(sessionId);
      await click("Close session");
    } catch {
      // Completed sessions already released their runtime.
    }
  }
  if (mcpOwned) {
    await control("mcp", "stop");
  }
  for (const name of [appId, privateHelper, helper]) {
    if (!baseline.packages[name]) {
      const installed = await adb("shell", `pm path ${name} || true`);
      if (installed.trim()) {
        await adb("uninstall", name);
      }
    }
  }
  receipt.cleanup.forwardsUnchanged =
    (await adb("forward", "--list")) === baseline.forwards;
  receipt.cleanup.imeUnchanged =
    (await adb(
      "shell",
      "settings",
      "get",
      "secure",
      "default_input_method"
    )) === baseline.ime;
  const helperProcess = await adb("shell", `pidof ${privateHelper} || true`);
  receipt.cleanup.helperStopped = !helperProcess.trim();
  receipt.cleanup.packagesRestored = true;
  for (const name of [appId, privateHelper, helper]) {
    const installed = await adb("shell", `pm path ${name} || true`);
    if (installed.trim() !== baseline.packages[name]) {
      receipt.cleanup.packagesRestored = false;
    }
  }
  const remainingTemporaryEntries = await readdir(tmpdir());
  receipt.cleanup.runtimeDirectoriesClean = !remainingTemporaryEntries.some(
    (name) =>
      name.startsWith("contingency-android-runtime-") &&
      !runtimeBaseline.has(name)
  );
  if (Object.values(receipt.cleanup).includes(false)) {
    receipt.blockers.push(
      "Owned-resource cleanup did not restore its baseline."
    );
    process.exitCode = 1;
  }
  await writeFile(path.join(artifacts, "journal.json"), safe(journal));
  await writeFile(path.join(artifacts, "receipt.json"), safe(receipt));
  await rm(hook, { force: true });
  await rm(audit, { force: true });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
