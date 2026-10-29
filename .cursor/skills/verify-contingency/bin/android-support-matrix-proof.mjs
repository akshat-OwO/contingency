/* oxlint-disable eslint/no-await-in-loop -- A selected device and Workspace gestures run sequentially. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { androidIdle, androidPick, openAndroidSheet } from "./android-ui.mjs";

// One Support Matrix cell: Teaching, a Dry Run, and verification of activate,
// public fill, private fill, and Back, then every documented-limit refusal.
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const cell = process.env.CONTINGENCY_ANDROID_MATRIX_CELL;
assert.ok(
  directory && serial && cell && /^[a-z0-9-]+$/u.test(cell),
  "Select an authorized device, a matrix cell name, and an isolated verification instance."
);
assert.equal(process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL, "authorized");
const physical = Boolean(process.env.CONTINGENCY_ANDROID_MODEL);
const feature = `android-support-matrix-${cell}`;
const root = path.resolve(import.meta.dirname, "../../../..");
const skillRoot = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(
  skillRoot,
  "artifacts",
  "android-support-matrix",
  cell
);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const execute = promisify(execFile);
const journal = [];
const sentinel = `Matrix-${randomUUID()}-Z9!`;
const observedValues = { encoded: false, literal: false };
const safe = (value) => {
  const text = JSON.stringify(value);
  observedValues.literal ||= text.includes(sentinel);
  observedValues.encoded ||= [
    Buffer.from(sentinel).toString("base64"),
    encodeURIComponent(sentinel),
  ].some((marker) => text.includes(marker));
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
const prop = async (name) => {
  const value = await adb("shell", "getprop", name);
  return value.trim();
};
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
const command = (input) => tool("agent_android_workspace", { command: input });
const read = (sessionId) => command({ _tag: "read", sessionId });
const observe = (sessionId) =>
  command({ _tag: "observe", image: false, sessionId });
/** A refusal exits nonzero; return its first printed line. */
const refusal = async (input, expected) => {
  try {
    await command(input);
  } catch (error) {
    const text = safe(String(error.stderr || error.stdout || error));
    assert.match(text, expected);
    return JSON.parse(text)
      .split("\n")
      .find((line) => expected.test(line));
  }
  assert.fail(`Expected an Android refusal matching ${expected}.`);
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
const waitText = (text) =>
  control("browser", "wait", "--text", text, "--timeout-ms", "90000");
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
// The driver's fill gesture, kept off command lines and out of the journal.
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
const find = (current, predicate, label) => {
  const matches = current.observation.nodes.filter(predicate);
  assert.equal(matches.length, 1, `Expected one ${label}.`);
  return matches[0];
};
const loginNameField = (node) =>
  node.editable && !node.password && node.name.includes("Login name");
const named = (name) => (node) => node.name === name && !node.covered;
const visible = (current, name) =>
  current.observation.nodes.some((node) => node.name === name);

const appId = "dev.contingency.physicalfixture";
const loginName = `matrix-${cell}`;
const api = Number(await prop("ro.build.version.sdk"));
const release = await prop("ro.build.version.release");
const flowSkillName = `${feature}-${process.pid}`;
const selection = {
  device: {
    api,
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial,
    ...(physical
      ? { kind: "physical", model: process.env.CONTINGENCY_ANDROID_MODEL }
      : { avd: process.env.CONTINGENCY_ANDROID_AVD }),
  },
  environment: {
    androidVersion: release,
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
  actions: {},
  blockers: [],
  cell,
  cleanup: {},
  device: { ...selection.device, release },
  feature,
  limits: {},
  receipts: {},
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
  safe(await readFile(audit, "utf-8"));
  receipt.variableEvidence = {
    inspectedFiles: files,
    literalValueObserved: observedValues.literal,
    logcatChecked: true,
  };
};
// Recovery is an explicit same-device Workspace choice, never an agent command.
const recoverIfPaused = async (sessionId) => {
  const retained = await read(sessionId);
  if (retained.phase === "paused") {
    await view(sessionId);
    await click(physical ? "Recover same device" : "Recover same emulator");
    await androidIdle(control);
  }
  const recovered = await read(sessionId);
  assert.equal(recovered.phase, "running", recovered.error ?? "");
};
// Dismisses a system dialog or another app's window from outside the runtime,
// then recovers the same device with a fresh observation.
const returnToFixture = async (sessionId) => {
  await adb("shell", "input", "keyevent", "4");
  // Window focus moves asynchronously; any display may list first (Android 16 adds the stream's).
  const focused = new RegExp(`mCurrentFocus=Window\\{[^}]*${appId}`, "u");
  const deadline = Date.now() + 15_000;
  while (!focused.test(await adb("shell", "dumpsys", "window", "displays"))) {
    assert.ok(Date.now() < deadline, "The fixture did not regain focus.");
    await delay(500);
  }
  await recoverIfPaused(sessionId);
};
/**
 * A Run refuses an untaught probe before input. The same window is then opened
 * from outside the runtime, as an app or person would, and the next
 * observation must pause the Run rather than act in it.
 */
const pausingProbe = async (sessionId, name, trigger, expected) => {
  const current = await observe(sessionId);
  const probe = find(current, named(name), name);
  const untaught = await refusal(
    {
      _tag: "input",
      action: { _tag: "activate", target: probe.target },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId,
    },
    /absent, covered, private, or unsupported/u
  );
  await recoverIfPaused(sessionId);
  await trigger(probe);
  const message = await refusal(
    { _tag: "observe", image: false, sessionId },
    expected
  );
  const paused = await read(sessionId);
  assert.equal(paused.phase, "paused");
  return { error: paused.error, pause: message, untaught };
};
const tapOutside = async ({ bounds }) => {
  assert.ok(bounds, "The probe needs bounds for an outside tap.");
  await adb(
    "shell",
    "input",
    "tap",
    String(Math.round(bounds.x + bounds.width / 2)),
    String(Math.round(bounds.y + bounds.height / 2))
  );
};

try {
  assert.ok(
    api >= 30 && api <= 36,
    `API ${api} is outside the Support Matrix.`
  );
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
  const tools = await control("mcp", "tools");
  assert.match(tools, /agent_android_workspace/u, "Android needs no opt-in.");

  // API levels outside 30 through 36 are refused at selection, before the device.
  receipt.limits.apiBelow30 = await refusal(
    {
      _tag: "start",
      flowSkillName,
      kind: "teaching",
      operationId: operation(),
      recordingId: null,
      selection: { ...selection, device: { ...selection.device, api: 29 } },
    },
    /below 30 are unsupported/u
  );

  // Teaching through Workspace: public fill, private fill, two activations, and Back.
  await control("browser", "goto", "--url", instance.mcpUrl);
  await openAndroidSheet(control, selection, flowSkillName, snapshot);
  const listed = await tool("agent_android_sessions_list", {});
  const teaching = listed.find(
    (session) =>
      session.flowSkillName === flowSkillName && session.phase !== "closed"
  );
  assert.ok(teaching);
  sessions.push(teaching.id);
  await prepare(teaching.id);
  await click("Start recording");
  await androidIdle(control);
  let current = await observe(teaching.id);
  const nameField = find(current, loginNameField, "login name field");
  await androidPick(control, teaching.id, nameField.role, nameField.name);
  const label = nameField.name || nameField.role;
  await wait(`Type into ${label}`, "form");
  await fill(`Text for ${label}`, loginName);
  await click("Type");
  await androidIdle(control);
  current = await observe(teaching.id);
  assert.ok(
    current.observation.nodes.some((node) => node.name.includes(loginName)),
    "The public fill is not visible in a fresh observation."
  );
  const field = find(current, (node) => node.password, "password field");
  await androidPick(control, teaching.id, field.role, field.name);
  await fill("Variable name", "PASSWORD");
  await click("Request Variable");
  await androidIdle(control);
  await supply("PASSWORD");
  await select("Variable", "PASSWORD");
  await click("Enter Variable");
  await androidIdle(control);
  await snapshot("teaching-private-fill");
  await androidPick(control, teaching.id, "button", "Sign in privately");
  current = await observe(teaching.id);
  assert.ok(visible(current, `Signed in as ${loginName}`));
  await androidPick(control, teaching.id, "button", "Open account");
  current = await observe(teaching.id);
  assert.ok(visible(current, "Account details"));
  await click("Android Back");
  await androidIdle(control);
  await snapshot("teaching-back-pressed");
  current = await observe(teaching.id);
  await writeFile(
    path.join(artifacts, "after-back-nodes.json"),
    safe(
      current.observation.nodes.map(({ bounds, name, role }) => ({
        bounds,
        name,
        role,
      }))
    )
  );
  assert.ok(visible(current, "Signed in privately"));
  await snapshot("teaching-back");
  await click("Stop recording");
  await androidIdle(control);
  const stopped = await read(teaching.id);
  assert.equal(stopped.captureState._tag, "ready");
  await snapshot("teaching-stopped");
  await click("Close session");
  await waitText("Closed");
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
  const kinds = actions.map((event) => event.kind);
  receipt.receipts.teaching = { kinds, recordingId };
  for (const [kind, count] of [
    ["fill", 1],
    ["variable", 1],
    ["activate", 2],
    ["back", 1],
  ]) {
    assert.equal(
      kinds.filter((entry) => entry === kind).length,
      count,
      `Teaching must record ${count} ${kind} action(s): ${kinds.join(", ")}`
    );
  }
  assert.ok(
    actions.some(
      (event) =>
        event.variableName === "PASSWORD" && event.target?.value === sentinel
    )
  );
  for (const event of actions) {
    for (const key of ["point", "bounds", "frame", "x", "y"]) {
      assert.equal(key in event, false, `Timeline leaks ${key}.`);
    }
  }
  const content = `---\nname: ${flowSkillName}\ndescription: Sign in with a public login name and a private password, open the account, and go back. Use when proving an Android Support Matrix cell.\ninputs:\n  - password\n---\n\n# Sign in and return\n\n1. Enter the public login name ${loginName}. Done when: the login name field shows it.\n2. Enter {{password}} in the private password field. Done when: the password field stays masked.\n3. Activate Sign in privately. Done when: Signed in as ${loginName} is visible.\n4. Activate Open account. Done when: Account details is visible.\n5. Go back. Done when: Signed in privately is visible.\n`;
  await tool("agent_flow_skill_save", {
    claimOperationId: claim,
    files: [{ content, path: "SKILL.md" }],
    operationId: operation(),
    recordingId,
  });
  process.stdout.write("Teaching and learning passed\n");

  // The agent repeats every matrix action in a fresh Dry Run, then a later Run.
  const agentJourney = async (kind) => {
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
    await supply("PASSWORD");
    const act = async (action) => {
      const before = await observe(started.id);
      const resolved =
        action._tag === "back"
          ? action
          : {
              ...action,
              target: find(before, action.match, action.label).target,
            };
      delete resolved.match;
      delete resolved.label;
      await command({
        _tag: "input",
        action: resolved,
        observationId: before.observation.id,
        operationId: operation(),
        sessionId: started.id,
      });
      receipt.actions[action._tag] = [
        ...(receipt.actions[action._tag] ?? []),
        kind,
      ];
      return observe(started.id);
    };
    await act({
      _tag: "fill",
      label: "login name field",
      match: loginNameField,
      text: loginName,
    });
    await act({
      _tag: "variable",
      label: "password field",
      match: (node) => node.password,
      name: "PASSWORD",
    });
    current = await act({
      _tag: "activate",
      label: "Sign in privately",
      match: named("Sign in privately"),
    });
    assert.ok(visible(current, `Signed in as ${loginName}`));
    current = await act({
      _tag: "activate",
      label: "Open account",
      match: named("Open account"),
    });
    assert.ok(visible(current, "Account details"));
    current = await act({ _tag: "back" });
    assert.ok(visible(current, "Signed in privately"));
    await scan();
    const finished = await command({
      _tag: "complete",
      assessment: {
        explanation: "Signed in privately is visible after Back",
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
      await waitText("Recording deleted");
      const verified = await read(started.id);
      assert.equal(verified.cleanup._tag, "purged");
    }
    return { id: started.id, outcome: finished.assessment.outcome };
  };
  receipt.receipts.dryRun = await agentJourney("dry-run");
  receipt.receipts.verification = { cleanup: "purged", decision: "verify" };
  process.stdout.write("Dry Run and verification passed\n");
  receipt.receipts.laterRun = await agentJourney("run");
  process.stdout.write("Later Run passed\n");

  // Documented limits, each refused or paused on a live Run.
  const limits = await command({
    _tag: "start",
    flowSkillName,
    kind: "run",
    operationId: operation(),
    recordingId: null,
    selection,
  });
  sessions.push(limits.id);
  await prepare(limits.id);
  receipt.limits.sameDeviceBound = await refusal(
    {
      _tag: "start",
      flowSkillName,
      kind: "run",
      operationId: operation(),
      recordingId: null,
      selection,
    },
    /already bound/u
  );
  receipt.limits.multipleBoundDevices = await refusal(
    {
      _tag: "start",
      flowSkillName,
      kind: "run",
      operationId: operation(),
      recordingId: null,
      selection: {
        ...selection,
        device: { ...selection.device, serial: "emulator-5998" },
      },
    },
    /Multiple bound devices are unsupported/u
  );
  current = await observe(limits.id);
  receipt.limits.rawCoordinates = {
    mcp: await refusal(
      {
        _tag: "input",
        action: { _tag: "tap", x: 100, y: 100 },
        observationId: current.observation.id,
        operationId: operation(),
        sessionId: limits.id,
      },
      /tap|Expected|_tag/u
    ),
  };
  // A raw Workspace point over blank space resolves to no element and sends nothing.
  await view(limits.id);
  await control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Take control"
  );
  await androidIdle(control);
  const blank = JSON.parse(
    await control(
      "browser",
      "android-pick",
      "--session-id",
      limits.id,
      "--fx",
      "0.5",
      "--fy",
      "0.8"
    )
  );
  await waitText("Nothing to activate there. No input was sent.");
  receipt.limits.rawCoordinates.workspace = {
    ...blank,
    refusal: "Nothing to activate there. No input was sent.",
  };
  await snapshot("limit-raw-coordinates");
  await click("Return control");
  await androidIdle(control);
  receipt.limits.systemDialog = await pausingProbe(
    limits.id,
    "Request camera permission",
    tapOutside,
    /ownership is unknown|outside the selected target app|capture is incomplete/u
  );
  await snapshot("limit-system-dialog");
  await returnToFixture(limits.id);
  receipt.limits.crossApp = await pausingProbe(
    limits.id,
    "Open device settings",
    () => adb("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS"),
    /ownership is unknown|outside the selected target app/u
  );
  await snapshot("limit-cross-app");
  await returnToFixture(limits.id);
  const beforeSecure = await observe(limits.id);
  receipt.limits.secureWindow = await pausingProbe(
    limits.id,
    "Show secure login window",
    tapOutside,
    /Secure window, not visible/u
  );
  await snapshot("limit-secure-window");
  const inconclusive = await command({
    _tag: "complete",
    assessment: {
      explanation: "The secure window hides the outcome",
      observationId: beforeSecure.observation.id,
      outcome: "working",
    },
    operationId: operation(),
    sessionId: limits.id,
  });
  assert.equal(inconclusive.assessment.outcome, "inconclusive");
  receipt.limits.secureWindow.outcome = inconclusive.assessment.outcome;
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
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifacts, "journal.json"), safe(journal));
  await writeFile(path.join(artifacts, "receipt.json"), safe(receipt));
  await rm(hook, { force: true });
  await rm(audit, { force: true });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
