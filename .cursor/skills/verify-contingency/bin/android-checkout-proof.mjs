// Workspace gestures, device installs, and Runs must happen in order on the selected device.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  androidComment,
  androidIdle,
  androidPick,
  openAndroidSheet,
} from "./android-ui.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href);
const execute = promisify(execFile);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(
  directory,
  "Set CONTINGENCY_VERIFY_DIR to the owned verification instance."
);
const readInstance = async () =>
  JSON.parse(await readFile(path.join(directory, "instance.json"), "utf-8"));
// A restarted MCP server listens on a new port.
let instance = await readInstance();
assert.ok(instance.mcpUrl, "Start this instance's MCP broker first.");
assert.equal(
  process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL,
  "authorized",
  "The operator must authorize installing the fixture builds on the explicitly selected device."
);
const skillRoot = path.join(root, ".cursor/skills/verify-contingency");
const physical = process.env.CONTINGENCY_ANDROID_MODEL !== undefined;
const artifacts = path.join(
  skillRoot,
  physical
    ? "artifacts/android-checkout-physical"
    : "artifacts/android-checkout"
);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const builds = JSON.parse(
  await readFile(
    path.join(skillRoot, "artifacts/android-checkout/builds/builds.json"),
    "utf-8"
  )
);
const build = (variant) => {
  const found = builds.builds.find((entry) => entry.variant === variant);
  assert.ok(found, `Build the ${variant} fixture first.`);
  return found;
};
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const appId = "dev.contingency.checkout";
const journal = [];
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `android-checkout-proof-${process.pid}-${sequence}`;
};
const run = (file, args, options = {}) =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        execute(file, args, {
          cwd: root,
          env: process.env,
          maxBuffer: 16 * 1024 * 1024,
          ...options,
        }),
    }).pipe(
      Effect.tap(({ stdout }) =>
        Effect.sync(() =>
          journal.push({
            args: [path.basename(file), ...args],
            stdout: stdout.length > 4000 ? `${stdout.slice(0, 4000)}…` : stdout,
          })
        )
      ),
      Effect.tapError((cause) =>
        Effect.sync(() =>
          journal.push({
            args: [path.basename(file), ...args],
            failure: String(cause?.stderr || cause?.stdout || cause),
          })
        )
      ),
      Effect.map(({ stdout }) => stdout)
    )
  );
const control = (...args) =>
  run("nub", [path.join(skillRoot, "bin/control-contingency"), ...args]);
const adb = (...args) => run("adb", ["-s", serial, ...args]);
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
/** A refusal exits nonzero; return its printed reason. */
const refusal = async (name, params) => {
  try {
    await tool(name, params);
  } catch (error) {
    return String(error?.stderr || error?.stdout || error);
  }
  assert.fail(`${name} was not refused.`);
};
const command = (input) => tool("agent_android_workspace", { command: input });
const click = (name, partial = false) =>
  control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    name,
    ...(partial ? ["--partial"] : [])
  );
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
  control(
    "browser",
    "wait",
    "--text",
    text,
    "--partial",
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

const reversibleActions = [
  { name: "Sign in", role: "button" },
  { name: "Add Anvil to cart", role: "button" },
  { name: "Open cart", role: "button" },
  { name: "Place mock order", role: "button" },
];
const outcome = { name: "Order confirmed", role: "group" };
const startingCondition = { name: "Fixture Shop sign in", role: "group" };
const shopper = "Fixture Shopper";
const selection = (variant) => ({
  device: {
    api: 36,
    ...(physical
      ? { kind: "physical", model: process.env.CONTINGENCY_ANDROID_MODEL }
      : { avd: process.env.CONTINGENCY_ANDROID_AVD }),
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial,
  },
  environment: {
    androidVersion: "16",
    appBuild: build(variant).appBuild,
    appId,
    // The setup sheet derives this from the starting element.
    startingState: `${startingCondition.role} ${startingCondition.name} is visible`,
  },
  helperConsent: "none",
  outcomes: [outcome],
  setup: {
    activity: `${appId}/.MainActivity`,
    conditions: [startingCondition],
    kind: physical ? "clear-app-data" : "restart-activity",
  },
});
assert.ok(
  Object.values(selection("working").device).every(
    (value) => value !== undefined
  ),
  "Supply the explicitly authorized device declarations."
);
const prepareName =
  selection("working").device.kind === "physical"
    ? "Prepare selected device"
    : "Prepare selected emulator";
const recoverName =
  selection("working").device.kind === "physical"
    ? "Recover same device"
    : "Recover same emulator";
const flowSkillName = `android-checkout-${process.pid}`;
const receipt = {
  blockers: [],
  builds: builds.builds.map(
    ({ appBuild, appId: id, sha256, variant, versionName }) => ({
      appBuild,
      appId: id,
      sha256,
      variant,
      versionName,
    })
  ),
  coverage: {},
  device: selection("working").device,
  feature: "android-checkout",
  flowSkillName,
};
const nodes = (session) => session.observation?.nodes ?? [];
const shows = (session, condition) =>
  nodes(session).some(
    (node) =>
      node.role === condition.role &&
      node.name === condition.name &&
      !node.covered
  );
const names = (session) => nodes(session).map((node) => node.name);
const read = (sessionId) => command({ _tag: "read", sessionId });
const observe = (sessionId) =>
  command({ _tag: "observe", image: false, sessionId });
const input = (session, action) =>
  command({
    _tag: "input",
    action,
    observationId: session.observation.id,
    operationId: operation(),
    sessionId: session.id,
  });
/** Mirrored input settles asynchronously; read fresh observations until the node appears. */
const untilShown = async (sessionId, condition) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await observe(sessionId);
    if (shows(current, condition)) {
      return current;
    }
    await sleep(1000);
  }
  assert.fail(`${condition.role} ${condition.name} never appeared.`);
};
const target = (session, condition) => {
  const node = session.observation.nodes.find(
    (candidate) =>
      candidate.role === condition.role &&
      candidate.name === condition.name &&
      !candidate.covered
  );
  assert.ok(node, `No visible ${condition.role} ${condition.name}.`);
  return node.target;
};
const installVariant = async (variant) => {
  const { apk, sha256 } = build(variant);
  assert.equal(
    createHash("sha256")
      .update(await readFile(apk))
      .digest("hex"),
    sha256,
    `${variant}.apk changed since it was built.`
  );
  const installed = /versionCode=(?<code>\d+) /u.exec(
    await adb("shell", "dumpsys", "package", appId)
  )?.groups?.code;
  // A release build cannot downgrade in place, and a nearly full device
  // cannot stage a second copy to replace one. Remove only this fixture first.
  if (installed !== undefined) {
    await adb("uninstall", appId);
  }
  await adb("install", apk);
  const dump = await adb("shell", "dumpsys", "package", appId);
  assert.ok(
    dump.includes(`versionCode=${build(variant).appBuild} `),
    `${variant} build was not installed.`
  );
};
const openView = async (sessionId) => {
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${sessionId}`
  );
  await wait("Workspace dock", "region");
};
const allowFixtureClear = async (sessionId) => {
  if (!physical) {
    return;
  }
  const current = await read(sessionId);
  if (
    !current.preparation.pending.some(
      (pending) => pending.kind === "clear-app-data"
    )
  ) {
    return;
  }
  await wait("Clear Target App data", "region");
  await snapshot(`fixture-clear-${sessionId}`);
  await control(
    "browser",
    "android-allow-request",
    "--name",
    "Clear Target App data"
  );
};
const prepare = async (sessionId) => {
  await openView(sessionId);
  await allowFixtureClear(sessionId);
  await wait(prepareName);
  await click(prepareName);
  await wait("Take control");
  const prepared = await observe(sessionId);
  // Preparation restarts the activity; a carried-over cart or sign-in is not fresh.
  assert.ok(
    shows(prepared, startingCondition),
    "Starting state was not fresh."
  );
  assert.ok(
    !names(prepared).includes("Catalog"),
    "Starting state carried a session."
  );
  return prepared;
};
/** The agent completes checkout using only declared semantic controls. */
const journey = async (sessionId) => {
  const field = { name: "Shopper name", role: "text-field" };
  let current = await untilShown(sessionId, field);
  await input(current, {
    _tag: "fill",
    target: target(current, field),
    text: shopper,
  });
  for (const action of reversibleActions) {
    current = await untilShown(sessionId, action);
    await input(current, { _tag: "activate", target: target(current, action) });
  }
  // The broken build never confirms; wait for either terminal heading.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    current = await observe(sessionId);
    if (
      shows(current, outcome) ||
      shows(current, { name: "Checkout failed", role: "group" })
    ) {
      return current;
    }
    await sleep(1000);
  }
  return current;
};
const complete = (session, outcomeName, explanation) =>
  command({
    _tag: "complete",
    assessment: {
      explanation,
      observationId: session.observation.id,
      outcome: outcomeName,
    },
    operationId: operation(),
    sessionId: session.id,
  });
const startSession = (kind, variant, recordingId = null) =>
  command({
    _tag: "start",
    flowSkillName,
    kind,
    operationId: operation(),
    recordingId,
    selection: selection(variant),
  });
const allowPermission = async (sessionId) => {
  await openView(sessionId);
  await wait("Run Environment Permission", "region");
  await snapshot(`permission-${sessionId}`);
  await control(
    "browser",
    "android-allow-request",
    "--name",
    "Run Environment Permission"
  );
  await allowFixtureClear(sessionId);
};

const adbText = async (...args) => {
  const output = await adb(...args);
  return output.trim();
};
const deviceState = async () => {
  const packages = await adbText("shell", "pm", "list", "packages");
  const enabledIme = await adbText(
    "shell",
    "settings",
    "get",
    "secure",
    "enabled_input_methods"
  );
  const ime = await adbText(
    "shell",
    "settings",
    "get",
    "secure",
    "default_input_method"
  );
  const forwards = await adbText("forward", "--list");
  return {
    enabledIme,
    forwards: forwards
      .split("\n")
      .filter((line) => line.split(/\s+/u)[0] === serial)
      .toSorted(),
    ime,
    packages: createHash("sha256")
      .update(packages.split("\n").toSorted().join("\n"))
      .digest("hex"),
  };
};
let originalState;
let installedHere = false;
const sessions = [];
let restartedEmulator;
try {
  assert.equal(
    await adbText("shell", "getprop", "ro.build.fingerprint"),
    process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    "Selected device fingerprint changed."
  );
  assert.equal(await adbText("shell", "getprop", "ro.build.version.sdk"), "36");
  if (physical) {
    assert.equal(
      process.env.CONTINGENCY_ANDROID_AVD,
      undefined,
      "Physical selection must use model, serial, and fingerprint only."
    );
    assert.equal(
      await adbText("shell", "getprop", "ro.product.model"),
      process.env.CONTINGENCY_ANDROID_MODEL
    );
    assert.equal(
      await adbText("shell", "am", "get-current-user"),
      "0",
      "Physical proof requires owner user 0."
    );
    assert.equal(
      process.env.CONTINGENCY_ANDROID_HELPER_CONSENT ?? "none",
      "none",
      "Install helpers separately with explicit consent before taking the physical baseline."
    );
    assert.notEqual(
      process.env.CONTINGENCY_ANDROID_DISCONNECT,
      "owned-emulator"
    );
    originalState = await deviceState();
  }
  const before = await adb("shell", "pm", "list", "packages", appId);
  if (physical) {
    assert.ok(
      !before.includes(`package:${appId}`),
      "Never replace an existing fixture on the physical phone."
    );
  }
  if (before.includes(`package:${appId}`)) {
    const signatures = await adb("shell", "dumpsys", "package", appId);
    assert.ok(
      signatures.includes("versionName=") &&
        /versionCode=[123] /u.test(signatures),
      `${appId} exists but is not this fixture. Remove nothing; choose another emulator.`
    );
  }
  installedHere = !before.includes(`package:${appId}`);
  await installVariant("working");

  // Teaching through mirrored Workspace.
  await control("browser", "goto", "--url", instance.mcpUrl);
  await openAndroidSheet(
    control,
    selection("working"),
    flowSkillName,
    snapshot
  );
  const listed = await tool("agent_android_sessions_list", {});
  const taughtSession = listed.find(
    (session) =>
      session.flowSkillName === flowSkillName && session.kind === "teaching"
  );
  assert.ok(taughtSession);
  assert.deepEqual(
    taughtSession.selection.device,
    selection("working").device,
    "Discovered device differs from explicit selection."
  );
  assert.equal(
    taughtSession.selection.reversibleActions,
    undefined,
    "UI must omit reversibleActions."
  );
  receipt.coverage.setupSheet = {
    discoveredApp: true,
    discoveredDevice: true,
    reversibleActionsOmitted: true,
  };
  assert.equal(taughtSession.selection.environment.appId, appId);
  assert.equal(
    taughtSession.selection.environment.appBuild,
    build("working").appBuild
  );
  sessions.push(taughtSession.id);
  const { recordingId } = taughtSession;
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${taughtSession.id}`
  );
  await allowFixtureClear(taughtSession.id);
  await wait(prepareName);
  await click(prepareName);
  await wait("Start recording");
  await click("Start recording");
  await wait("Stop recording");
  await snapshot("teaching-started");
  // Read the append-only capture to prove refusals add no action, then compare the
  // complete claimed Timeline below. Never retain frame pixels from this file.
  const actionCount = async () => {
    const events = await readFile(
      path.join(
        instance.stateDir,
        "catalog/.recordings",
        recordingId,
        "events.jsonl"
      ),
      "utf-8"
    );
    return events
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry._tag === "action").length;
  };
  const noOverlays = JSON.parse(
    await control("browser", "android-no-overlays")
  );
  assert.equal(noOverlays.noOverlays, true);
  receipt.coverage.noOverlays = noOverlays;
  await snapshot("no-overlays");
  const beforeRefusals = await actionCount();
  // The sign-in fixture leaves the lower half blank, before the IME is opened.
  const empty = JSON.parse(
    await control(
      "browser",
      "android-pick",
      "--session-id",
      taughtSession.id,
      "--fx",
      "0.5",
      "--fy",
      "0.75"
    )
  );
  await waitText("Nothing to activate there. No input was sent.");
  assert.equal(await actionCount(), beforeRefusals);
  receipt.coverage.pickRefusesEmpty = {
    ...empty,
    actionsAfter: await actionCount(),
    actionsBefore: beforeRefusals,
    noInput: true,
  };
  await snapshot("pick-refuses-empty");
  await androidPick(control, taughtSession.id, "text-field", "Shopper name");
  await wait("Type into Shopper name", "form");
  await snapshot("field-picked");
  await fill("Text for Shopper name", shopper);
  await click("Type");
  await androidIdle(control);
  const typed = await observe(taughtSession.id);
  assert.ok(
    nodes(typed).some((node) => node.name.includes(shopper)),
    "Fresh observation does not contain typed shopper name."
  );
  receipt.coverage.fieldTyping = {
    form: "Type into Shopper name",
    observationId: typed.observation.id,
    value: shopper,
  };
  await snapshot("field-typed");
  // Typing leaves the soft keyboard open. Its keys are hittable elements of
  // another app, named "Other window" in the observation; aim at one.
  const keyboard = typed.observation;
  const foreign = nodes(typed)
    .filter(
      (node) =>
        node.name === "Other window" &&
        node.bounds !== undefined &&
        node.bounds.width > 0 &&
        node.bounds.height > 0 &&
        node.bounds.y > keyboard.height / 2
    )
    .toSorted(
      (left, right) =>
        left.bounds.width * left.bounds.height -
        right.bounds.width * right.bounds.height
    )
    .find((node) => node.role === "text" || node.role === "button");
  assert.ok(foreign, "The soft keyboard is not open after typing.");
  const beforeOutside = await actionCount();
  const outsidePick = JSON.parse(
    await control(
      "browser",
      "android-pick",
      "--session-id",
      taughtSession.id,
      "--fx",
      String((foreign.bounds.x + foreign.bounds.width / 2) / keyboard.width),
      "--fy",
      String((foreign.bounds.y + foreign.bounds.height / 2) / keyboard.height)
    )
  );
  await waitText("That element belongs to another app. No input was sent.");
  assert.equal(await actionCount(), beforeOutside);
  receipt.coverage.pickRefusesOutsideApp = {
    ...outsidePick,
    actionsAfter: await actionCount(),
    actionsBefore: beforeOutside,
    noInput: true,
  };
  await snapshot("pick-refuses-outside-app");
  await androidPick(control, taughtSession.id, "button", "Sign in");
  await untilShown(taughtSession.id, reversibleActions[1]);
  await snapshot("pick-activates");
  await androidComment(
    control,
    "Sign in with the public fixture shopper name."
  );
  await androidPick(control, taughtSession.id, "button", "Add Anvil to cart");
  await untilShown(taughtSession.id, { name: "Cart: 1 item", role: "text" });
  await androidPick(control, taughtSession.id, "button", "Open cart");
  await untilShown(taughtSession.id, reversibleActions[3]);
  await androidPick(control, taughtSession.id, "button", "Place mock order");
  await untilShown(taughtSession.id, outcome);
  await androidComment(
    control,
    "Checkout is done when Order confirmed is visible. The mock order takes no payment."
  );
  await snapshot("teaching-checkout");
  await click("Stop recording");
  await waitText("Ask an agent to learn this recording.");
  const stopped = await read(taughtSession.id);
  assert.equal(stopped.captureState._tag, "ready");
  assert.deepEqual(
    stopped.requirements.reversibleActions,
    reversibleActions,
    "Teaching must derive allowed activations from the captured journey."
  );
  await snapshot("teaching-stopped");
  await click("Close session");
  await wait("New session");

  await tool("agent_teaching_recording_claim", {
    action: "take",
    claimOperationId: null,
    error: null,
    operationId: "android-checkout-claim",
    recordingId,
  });
  const timeline = await tool("agent_teaching_timeline_get", {
    claimOperationId: "android-checkout-claim",
    cursor: 0,
    recordingId,
  });
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2),
    { mode: 0o600 }
  );
  const entries = timeline.entries.map((entry) =>
    entry._tag === "action" ? `action:${entry.description}` : entry._tag
  );
  const actions = timeline.entries.filter((entry) => entry._tag === "action");
  assert.deepEqual(
    actions.map((entry) => entry.description),
    [
      "Enter public fixture text in text-field Shopper name",
      "Activate button Sign in",
      "Activate button Add Anvil to cart",
      "Activate button Open cart",
      "Activate button Place mock order",
    ]
  );
  const forbidden = new Set(["point", "bounds", "frame", "x", "y"]);
  const assertSemantic = (value) => {
    if (value === null || Object(value) !== value) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.ok(
        !forbidden.has(key),
        `Timeline action contains coordinate key ${key}.`
      );
      assertSemantic(child);
    }
  };
  for (const action of actions) {
    assertSemantic(action);
  }
  receipt.coverage.pickActivates = {
    coordinateKeysAbsent: true,
    descriptions: actions
      .filter((entry) => entry.kind === "activate")
      .map((entry) => entry.description),
    semantic: true,
  };
  const instructions = timeline.entries.filter(
    (entry) => entry._tag === "instruction"
  );
  assert.equal(instructions.length, 2);
  // The first Instruction sits between Sign in and Add Anvil, as it was recorded.
  assert.ok(
    entries.indexOf("action:Activate button Sign in") <
      entries.indexOf("instruction") &&
      entries.indexOf("instruction") <
        entries.indexOf("action:Activate button Add Anvil to cart")
  );
  const serialized = JSON.stringify(timeline);
  assert.ok(serialized.includes(shopper), "Public fill text is missing.");
  assert.ok(serialized.includes("Order confirmed"), "No checkout observation.");
  receipt.coverage.teaching = {
    actions: actions.map((entry) => entry.description),
    entries,
    instructions: instructions.map((entry) => entry.text),
    recordingId,
  };

  await tool("agent_flow_skill_save", {
    claimOperationId: "android-checkout-claim",
    files: [
      {
        content: `---\nname: ${flowSkillName}\ndescription: Sign in to the fixture shop, add an Anvil, and place a mock order. Use when checking the experimental Android checkout.\ninputs:\n---\n\n# Mock checkout\n\n1. Enter ${shopper} in the Shopper name field. Done when: the field shows ${shopper}.\n2. Activate Sign in. Done when: Catalog is visible.\n3. Activate Add Anvil to cart. Done when: Cart: 1 item is visible.\n4. Activate Open cart. Done when: Place mock order is visible.\n5. Activate Place mock order. Done when: Order confirmed is visible.\n`,
        path: "SKILL.md",
      },
    ],
    operationId: operation(),
    recordingId,
  });
  const skillFile = path.join(
    instance.stateDir,
    "catalog",
    flowSkillName,
    "SKILL.md"
  );
  const saved = await readFile(skillFile, "utf-8");
  assert.ok(saved.includes('"platform":"android"'));
  assert.ok(saved.includes('"appBuild":"1"'));

  // Fresh Dry Run, refusals, and explicit verification.
  const dry = await startSession("dry-run", "working", recordingId);
  sessions.push(dry.id);
  let current = await prepare(dry.id);
  const staleObservationId = current.observation.id;
  current = await observe(dry.id);
  const stale = await refusal("agent_android_workspace", {
    command: {
      _tag: "input",
      action: {
        _tag: "activate",
        target: target(current, reversibleActions[0]),
      },
      observationId: `${staleObservationId}-stale`,
      operationId: operation(),
      sessionId: dry.id,
    },
  });
  assert.match(stale, /stale/u);
  const privateText = await refusal("agent_android_workspace", {
    command: {
      _tag: "input",
      action: {
        _tag: "fill",
        target: target(current, { name: "Shopper name", role: "text-field" }),
        text: "Pässword",
      },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: dry.id,
    },
  });
  assert.match(privateText, /Private Variables are unavailable/u);
  const coordinate = await refusal("agent_android_workspace", {
    command: {
      _tag: "input",
      action: { _tag: "tap", x: 100, y: 100 },
      observationId: current.observation.id,
      operationId: operation(),
      sessionId: dry.id,
    },
  });
  receipt.coverage.refusals = {
    coordinate: coordinate.split("\n").find(Boolean),
    privateText: privateText.split("\n").find(Boolean),
    staleTarget: stale.split("\n").find(Boolean),
  };
  current = await journey(dry.id);
  assert.ok(shows(current, outcome), "Dry Run did not reach Order confirmed.");
  const passed = await complete(
    current,
    "working",
    "Order confirmed was observed after the mock checkout."
  );
  assert.equal(passed.captureState._tag, "dry-run-passed");
  await openView(dry.id);
  await wait("Verify flow");
  await snapshot("dry-run-passed");
  await click("Verify flow");
  // The badge, not the Run Summary sentence that starts the same way.
  await control(
    "browser",
    "wait",
    "--text",
    "Recording deleted",
    "--timeout-ms",
    "90000"
  );
  const verified = await read(dry.id);
  assert.equal(verified.captureState._tag, "verified");
  assert.equal(verified.cleanup._tag, "purged");
  assert.equal(
    existsSync(
      path.join(instance.stateDir, "catalog/.recordings", recordingId)
    ),
    false
  );
  await snapshot("verified-cleanup");
  const verification = await readFile(
    path.join(
      instance.stateDir,
      "catalog",
      flowSkillName,
      "references/verification.md"
    ),
    "utf-8"
  );
  assert.ok(verification.includes("- Platform: android"));
  receipt.coverage.dryRun = {
    assessment: passed.assessment,
    freshStart: true,
    id: dry.id,
    purged: true,
    verifiedInWorkspace: true,
  };

  // Changed successful build: refusal, then a Run-scoped grant.
  await installVariant("changed");
  const refusedRun = await startSession("run", "changed");
  sessions.push(refusedRun.id);
  assert.deepEqual(
    refusedRun.preparation.differences.map((entry) => entry.field),
    ["appBuild"]
  );
  await openView(refusedRun.id);
  await wait("Run Environment Permission", "region");
  await control(
    "browser",
    "android-refuse-request",
    "--name",
    "Run Environment Permission"
  );
  // The badge alone; the status sentence also mentions the refusal.
  await control(
    "browser",
    "wait",
    "--text",
    "Refused",
    "--timeout-ms",
    "90000"
  );
  const refusedRead = await read(refusedRun.id);
  assert.equal(refusedRead.phase, "refused");
  const refusedInput = await refusal("agent_android_workspace", {
    command: { _tag: "observe", image: false, sessionId: refusedRun.id },
  });
  await snapshot("changed-refused");
  const changed = await startSession("run", "changed");
  sessions.push(changed.id);
  await allowPermission(changed.id);
  await wait(prepareName);
  await click(prepareName);
  await wait("Take control");
  current = await observe(changed.id);
  assert.ok(shows(current, startingCondition));
  current = await journey(changed.id);
  assert.ok(
    shows(current, outcome),
    "Changed build did not confirm the order."
  );
  const changedComplete = await complete(
    current,
    "working",
    "The changed build confirmed the mock order."
  );
  assert.equal(changedComplete.assessment.outcome, "working");
  assert.ok(
    changedComplete.preparation.evidence.some((entry) => entry.type === "grant")
  );
  await openView(changed.id);
  await wait("Run Summary", "complementary");
  await snapshot("changed-run-summary");
  const unchangedSkill = await readFile(skillFile, "utf-8");
  assert.ok(unchangedSkill.includes('"appBuild":"1"'), "Taught build changed.");
  receipt.coverage.changedBuild = {
    assessment: changedComplete.assessment,
    differences: changedComplete.preparation.differences,
    grantRunScoped: true,
    id: changed.id,
    refusal: {
      id: refusedRun.id,
      observeRefused: refusedInput.split("\n").find(Boolean),
    },
    taughtBuildRetained: true,
  };

  // Deliberately broken build: dispatch alone never passes.
  await installVariant("broken");
  const claimed = await startSession("run", "broken");
  sessions.push(claimed.id);
  await allowPermission(claimed.id);
  await wait(prepareName);
  await click(prepareName);
  await wait("Take control");
  current = await journey(claimed.id);
  assert.ok(!shows(current, outcome));
  assert.ok(names(current).includes("Checkout failed"));
  const downgraded = await complete(
    current,
    "working",
    "Every checkout action was dispatched."
  );
  assert.equal(downgraded.assessment.outcome, "inconclusive");
  const failed = await startSession("run", "broken");
  sessions.push(failed.id);
  await allowPermission(failed.id);
  await wait(prepareName);
  await click(prepareName);
  await wait("Take control");
  current = await journey(failed.id);
  const notWorking = await complete(
    current,
    "not-working",
    "Checkout failed: the mock payment service was unavailable and Order confirmed never appeared."
  );
  assert.equal(notWorking.assessment.outcome, "not-working");
  await openView(failed.id);
  await wait("Run Summary", "complementary");
  await snapshot("broken-run-summary");
  receipt.coverage.brokenBuild = {
    dispatchOnlyClaim: { assessment: downgraded.assessment, id: claimed.id },
    notWorking: { assessment: notWorking.assessment, id: failed.id },
  };

  if (physical) {
    receipt.coverage.unexpectedApp = {
      skipped: "Physical proof never opens Settings or leaves the fixture.",
    };
    receipt.coverage.captureLoss = {
      skipped: "Physical proof preserves the daily phone foreground boundary.",
    };
  } else {
    // Unexpected app: another app takes the foreground mid-Run.
    const paused = await startSession("run", "broken");
    sessions.push(paused.id);
    await allowPermission(paused.id);
    await wait(prepareName);
    await click(prepareName);
    await wait("Take control");
    await adb("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS");
    const outside = await refusal("agent_android_workspace", {
      command: { _tag: "observe", image: false, sessionId: paused.id },
    });
    const pausedRead = await read(paused.id);
    assert.equal(pausedRead.phase, "paused");
    await openView(paused.id);
    await wait(recoverName);
    await snapshot("unexpected-app-paused");
    await adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
    await click(recoverName);
    await wait("Take control");
    const recovered = await observe(paused.id);
    assert.notEqual(recovered.observation.id, pausedRead.observation?.id);
    assert.equal(recovered.phase, "running");
    await click("Close session");
    receipt.coverage.unexpectedApp = {
      captureGaps: pausedRead.captureGaps,
      pause: outside.split("\n").find(Boolean),
      recoveredObservation: recovered.observation.id,
    };

    // Capture loss ends Teaching as incomplete; it cannot be learned.
    await installVariant("working");
    const lost = await startSession("teaching", "working");
    sessions.push(lost.id);
    await openView(lost.id);
    await allowFixtureClear(lost.id);
    await wait(prepareName);
    await click(prepareName);
    await wait("Start recording");
    await click("Start recording");
    await wait("Stop recording");
    // The Workspace mirror detects the foreign app on its next capture, before any input.
    await adb("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS");
    await wait(recoverName);
    const lostRead = await read(lost.id);
    assert.equal(lostRead.captureState._tag, "failed");
    await snapshot("capture-loss");
    await adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
    await click("Close session");
    const learnRefused = await refusal("agent_teaching_recording_claim", {
      action: "take",
      claimOperationId: null,
      error: null,
      operationId: "android-checkout-lost-claim",
      recordingId: lost.recordingId,
    });
    receipt.coverage.captureLoss = {
      captureGaps: lostRead.captureGaps,
      claimRefused: learnRefused.split("\n").find(Boolean),
      lifecycle: lostRead.captureState,
    };
  }

  // A restarted server owns no device; it rereads retained Summaries.
  await control("mcp", "stop");
  await control("mcp", "start");
  instance = await readInstance();
  const reread = {};
  for (const [name, id] of Object.entries({
    brokenClaim: claimed.id,
    brokenFailed: failed.id,
    changed: changed.id,
    dryRun: dry.id,
  })) {
    const summary = await read(id);
    reread[name] = {
      assessment: summary.assessment?.outcome ?? null,
      captureState: summary.captureState?._tag ?? null,
      cleanup: summary.cleanup?._tag ?? null,
    };
  }
  assert.equal(reread.dryRun.captureState, "verified");
  assert.equal(reread.dryRun.cleanup, "purged");
  assert.equal(reread.changed.assessment, "working");
  assert.equal(reread.brokenClaim.assessment, "inconclusive");
  assert.equal(reread.brokenFailed.assessment, "not-working");
  receipt.coverage.restart = reread;

  // Disconnect: only an emulator this operator started for the proof may be killed.
  if (
    !physical &&
    process.env.CONTINGENCY_ANDROID_DISCONNECT === "owned-emulator"
  ) {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    assert.ok(sdk, "Export ANDROID_HOME to restart the owned emulator.");
    const disconnected = await startSession("run", "working");
    sessions.push(disconnected.id);
    await prepare(disconnected.id);
    // A console screen recording ends with the emulator; finalize it first.
    await adb("emu", "screenrecord", "stop").catch((error) =>
      journal.push({
        cause: String(error),
        note: "No screen recording to finalize.",
      })
    );
    await adb("emu", "kill");
    // The agent holds control, so its next observation is what detects the loss.
    const lostDevice = await refusal("agent_android_workspace", {
      command: { _tag: "observe", image: false, sessionId: disconnected.id },
    });
    await wait(recoverName);
    const pausedByDisconnect = await read(disconnected.id);
    assert.equal(pausedByDisconnect.phase, "paused");
    await snapshot("disconnect-paused");
    const whileAbsent = await refusal("agent_android_workspace", {
      command: {
        _tag: "recover",
        operationId: operation(),
        sessionId: disconnected.id,
      },
    });
    await click(recoverName);
    await wait(recoverName);
    const stillPaused = await read(disconnected.id);
    assert.equal(stillPaused.phase, "paused");
    const consolePort = /^emulator-(?<port>\d+)$/u.exec(serial)?.groups?.port;
    assert.ok(
      consolePort,
      "Disconnect recovery needs an emulator-<port> serial."
    );
    const emulator = spawn(
      path.join(sdk, "emulator/emulator"),
      [
        "-avd",
        process.env.CONTINGENCY_ANDROID_AVD,
        // Keep the selected serial: emulator-<port> is derived from the console port.
        "-port",
        consolePort,
        "-no-snapshot-save",
        "-no-boot-anim",
        "-no-window",
        "-memory",
        "2048",
      ],
      { detached: true, stdio: "ignore" }
    );
    restartedEmulator = emulator;
    receipt.resources = [
      {
        consolePort,
        owner: "android-checkout-proof",
        pid: emulator.pid,
        serial,
        startedAt: new Date().toISOString(),
        stop: `adb -s ${serial} emu kill`,
      },
    ];
    let emulatorExit = null;
    emulator.once("exit", (code, signal) => {
      emulatorExit = signal ?? `code ${code}`;
    });
    emulator.unref();
    // Bounded boot wait: each probe has its own timeout, and an emulator that
    // exits or never boots fails the stage instead of hanging the proof.
    let booted = false;
    for (let attempt = 0; attempt < 240 && !booted; attempt += 1) {
      assert.equal(
        emulatorExit,
        null,
        `The restarted emulator exited (${emulatorExit}) before booting.`
      );
      const state = await run(
        "adb",
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { timeout: 10_000 }
      ).catch(() => "");
      booted = state.trim() === "1";
      if (!booted) {
        await sleep(1000);
      }
    }
    assert.ok(booted, `${serial} did not finish booting within 240 seconds.`);
    // A cold boot restores the quickboot snapshot, which may predate the fixture.
    await installVariant("working");
    await adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
    await click(recoverName);
    await wait("Take control");
    const reconnected = await observe(disconnected.id);
    assert.equal(reconnected.phase, "running");
    assert.equal(reconnected.selection.device.serial, serial);
    await snapshot("disconnect-recovered");
    receipt.coverage.disconnect = {
      agentRecoveryRefused: whileAbsent.split("\n").find(Boolean),
      captureGaps: pausedByDisconnect.captureGaps,
      detectedBy: lostDevice.split("\n").find(Boolean),
      recoveredObservation: reconnected.observation.id,
      sameSerial: serial,
      workspaceRecoveryWhileAbsent: stillPaused.error,
    };
  } else if (physical) {
    receipt.coverage.disconnect = {
      skipped: "Physical disconnect is a separate manually authorized proof.",
    };
  } else {
    receipt.blockers.push(
      "Disconnect not driven: set CONTINGENCY_ANDROID_DISCONNECT=owned-emulator for an emulator this operator started."
    );
    process.exitCode = 1;
  }
} catch (error) {
  receipt.blockers.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  await snapshot("failure").catch((snapshotError) =>
    receipt.blockers.push(
      `Failure snapshot unavailable: ${String(snapshotError)}`
    )
  );
} finally {
  // Owned cleanup: sessions this proof opened, then the fixture it installed.
  const closeRefusals = [];
  for (const id of sessions) {
    try {
      const current = await read(id);
      if (["pending", "running", "paused"].includes(current.phase)) {
        await openView(id);
        await click("Close session");
        await wait("New session");
        const closedSession = await read(id);
        assert.equal(closedSession.phase, "closed");
      }
    } catch (error) {
      closeRefusals.push({ error: String(error), id });
      receipt.blockers.push(`Session cleanup failed: ${id}`);
      process.exitCode = 1;
    }
  }
  let uninstallFailure = null;
  if (installedHere) {
    await adb("uninstall", appId).catch((error) => {
      uninstallFailure = String(error?.stderr || error);
    });
  }
  const helper = await adb(
    "shell",
    "pidof com.callstack.agentdevice.snapshothelper || true"
  ).catch(() => "unknown");
  const forwards = await adb("forward", "--list").catch(() => "unknown");
  receipt.cleanup = {
    closeRefusals,
    fixtureUninstalled: installedHere && uninstallFailure === null,
    helperProcess: helper.trim() || null,
    ownedForwards: forwards
      .split("\n")
      .filter((line) => line.startsWith(serial)),
    uninstallFailure,
  };
  if (
    restartedEmulator &&
    restartedEmulator.exitCode === null &&
    restartedEmulator.signalCode === null
  ) {
    try {
      // The emulator runs detached and unreferenced, so its exit event cannot
      // keep this process alive; poll its pid instead, for a bounded time.
      await adb("emu", "kill");
      const { pid } = restartedEmulator;
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let waited = 0; alive() && waited < 30_000; waited += 500) {
        await sleep(500);
      }
      assert.ok(!alive(), `Owned emulator ${pid} did not exit.`);
      receipt.cleanup.restartedEmulatorStopped = true;
    } catch (error) {
      receipt.blockers.push(`Owned emulator cleanup failed: ${String(error)}`);
      process.exitCode = 1;
    }
  }
  if (physical && originalState) {
    try {
      const restored = await deviceState();
      receipt.coverage.deviceStateRestored =
        restored.packages === originalState.packages &&
        restored.ime === originalState.ime &&
        restored.enabledIme === originalState.enabledIme;
      receipt.coverage.forwardsRestored =
        JSON.stringify(restored.forwards) ===
        JSON.stringify(originalState.forwards);
      assert.ok(
        receipt.coverage.deviceStateRestored &&
          receipt.coverage.forwardsRestored,
        "Physical package, IME, or forward baseline changed; inspect owned cleanup. No settings will be changed to hide drift."
      );
    } catch (error) {
      receipt.blockers.push(String(error));
      process.exitCode = 1;
    }
  }
  if (uninstallFailure) {
    receipt.blockers.push(`Fixture uninstall failed: ${uninstallFailure}`);
    process.exitCode = 1;
  }
  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
