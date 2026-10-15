// Workspace gestures and navigation must run in order on the selected device.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href);
const execute = promisify(execFile);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(
  directory,
  "Set CONTINGENCY_VERIFY_DIR to the owned verification instance."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start this instance's MCP broker first.");
const physical = process.env.CONTINGENCY_ANDROID_MODEL !== undefined;
const artifacts = path.join(
  root,
  physical
    ? ".cursor/skills/verify-contingency/artifacts/android-stream-physical"
    : ".cursor/skills/verify-contingency/artifacts/android-stream"
);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const journal = [];
const control = (...args) =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        execute(
          "nub",
          [
            path.join(
              root,
              ".cursor/skills/verify-contingency/bin/control-contingency"
            ),
            ...args,
          ],
          {
            cwd: root,
            env: process.env,
            maxBuffer: 8 * 1024 * 1024,
          }
        ),
    }).pipe(
      Effect.tap(({ stdout }) =>
        Effect.sync(() => journal.push({ args, stdout }))
      ),
      Effect.map(({ stdout }) => stdout)
    )
  );
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
    "60000"
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
const selection = {
  device: {
    api: 36,
    ...(physical
      ? { kind: "physical", model: process.env.CONTINGENCY_ANDROID_MODEL }
      : { avd: process.env.CONTINGENCY_ANDROID_AVD }),
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial: process.env.CONTINGENCY_ANDROID_SERIAL,
  },
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.contingency.physicalfixture",
    startingState: "Fresh stream fixture activity",
  },
  helperConsent: "none",
  outcomes: [{ name: "Stream fixture ready", role: "text" }],
  reversibleActions: [
    { name: "Change screen", role: "button" },
    { name: "Show secure window", role: "button" },
    { name: "Hide secure window", role: "button" },
  ],
  setup: {
    activity: "dev.contingency.physicalfixture/.StreamActivity",
    conditions: [{ name: "Stream fixture ready", role: "text" }],
    kind: physical ? "clear-app-data" : "restart-activity",
  },
};
assert.ok(
  Object.values(selection.device).every((value) => value !== undefined),
  "Supply the explicitly authorized device declarations."
);
const flowSkillName = `android-stream-${process.pid}`;
const receipt = {
  blockers: [],
  coverage: {},
  device: {
    api: selection.device.api,
    kind: physical ? "physical" : "emulator",
    model: physical ? selection.device.model : selection.device.avd,
  },
  entryPoint: "Workspace Android experimental",
  feature: "android-stream",
};
let sessionId;
const forwards = async () => {
  const { stdout } = await execute("adb", [
    "-s",
    selection.device.serial,
    "forward",
    "--list",
  ]);
  return stdout.trim();
};
const baseline = await forwards();
const deviceState = async () => {
  const read = async (args) => {
    const { stdout } = await execute("adb", [
      "-s",
      selection.device.serial,
      ...args,
    ]);
    return stdout.trim();
  };
  const packages = await read(["shell", "pm", "list", "packages"]);
  return {
    enabledIme: await read([
      "shell",
      "settings",
      "get",
      "secure",
      "enabled_input_methods",
    ]),
    ime: await read([
      "shell",
      "settings",
      "get",
      "secure",
      "default_input_method",
    ]),
    packages: createHash("sha256")
      .update(packages.split("\n").toSorted().join("\n"))
      .digest("hex"),
  };
};
const originalState = await deviceState();
const apk = process.env.CONTINGENCY_ANDROID_STREAM_FIXTURE_APK;
assert.ok(
  apk && process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL_CONSENT === "install",
  "Authorize the disposable stream fixture installation."
);
const installed = await execute("adb", [
  "-s",
  selection.device.serial,
  "shell",
  "pm",
  "list",
  "packages",
  selection.environment.appId,
]);
assert.equal(installed.stdout.trim(), "", "Never replace an existing fixture");
await execute("adb", [
  "-s",
  selection.device.serial,
  "install",
  "--no-streaming",
  apk,
]);
try {
  await control("browser", "goto", "--url", instance.mcpUrl);
  await wait("Android experimental");
  await click("Android experimental");
  if (physical) {
    await control(
      "browser",
      "select",
      "--role",
      "combobox",
      "--name",
      "Device kind",
      "--value",
      "physical"
    );
    await control(
      "browser",
      "select",
      "--role",
      "combobox",
      "--name",
      "Notification permission",
      "--value",
      "revoke"
    );
  }
  const fields = {
    "Flow Skill name": flowSkillName,
    "Required outcome name": "Stream fixture ready",
    "Required outcome role": "text",
    "Reversible actions":
      "button: Change screen\nbutton: Show secure window\nbutton: Hide secure window",
    "Selected AVD or device model": physical
      ? selection.device.model
      : selection.device.avd,
    "Selected build fingerprint": selection.device.fingerprint,
    "Selected device serial": selection.device.serial,
    "Starting activity": selection.setup.activity,
    "Starting condition name": "Stream fixture ready",
    "Starting condition role": "text",
    "Starting state description": selection.environment.startingState,
    "Target App package": selection.environment.appId,
    "Target App versionCode": "1",
  };
  for (const [name, value] of Object.entries(fields)) {
    await control(
      "browser",
      "fill",
      "--role",
      "textbox",
      "--name",
      name,
      "--value",
      value
    );
  }
  // A cold-booted emulator may lack the pinned helper; the operator opts in.
  await control(
    "browser",
    "select",
    "--role",
    "combobox",
    "--name",
    "Helper authorization",
    "--value",
    process.env.CONTINGENCY_ANDROID_HELPER_CONSENT ?? "none"
  );
  await click("Open experimental Android session");
  if (physical) {
    await control(
      "browser",
      "wait",
      "--role",
      "group",
      "--name",
      "Clear Target App data"
    );
    await snapshot("fixture-data-consent");
    await click("Allow");
  }
  await wait("Prepare selected device");
  await click("Prepare selected device");
  await wait("Start recording");

  const sessions = await tool("agent_android_sessions_list", {});
  sessionId = sessions.find(
    (session) => session.flowSkillName === flowSkillName
  )?.id;
  assert.ok(sessionId);
  const check = async (previous) =>
    JSON.parse(
      await control(
        "browser",
        "android-stream-check",
        "--session-id",
        sessionId,
        ...(previous ? ["--previous-frame", previous] : [])
      )
    );
  const first = await check();
  receipt.coverage.live = first;
  await snapshot("live");
  await click("Activate button Change screen");
  await control(
    "browser",
    "wait",
    "--text",
    "Live device display",
    "--timeout-ms",
    "60000"
  );
  const second = await check(first.frame);
  assert.notEqual(second.frame, first.frame);
  receipt.coverage.changedFrame = true;
  await snapshot("changed-frame");
  await click("Activate button Show secure window");
  await control(
    "browser",
    "wait",
    "--text",
    "Secure window, not visible",
    "--timeout-ms",
    "60000"
  );
  await snapshot("secure-window");
  await click("Activate button Hide secure window");
  await control(
    "browser",
    "wait",
    "--text",
    "Live device display",
    "--timeout-ms",
    "60000"
  );
  receipt.coverage.secureWindow = true;
  const { stdout: processes } = await execute("ps", [
    "-axo",
    "pid=,ppid=,command=",
  ]);
  const workers = processes.split("\n").flatMap((line) => {
    const match = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+(?<command>.+)$/u.exec(
      line
    )?.groups;
    return match &&
      match.command.includes("/android-stream-worker.js") &&
      processes.split("\n").some((parent) => {
        const owner = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+/u.exec(
          parent
        )?.groups;
        return (
          owner &&
          Number(owner.pid) === Number(match.parent) &&
          Number(owner.parent) === instance.mcpPid
        );
      })
      ? [Number(match.pid)]
      : [];
  });
  assert.equal(
    workers.length,
    1,
    "One stream worker must belong to this MCP process"
  );
  process.kill(workers[0], "SIGKILL");
  await control(
    "browser",
    "wait",
    "--text",
    "Device stream lost. Semantic controls remain available.",
    "--timeout-ms",
    "60000"
  );
  await snapshot("stream-lost");
  await click("Activate button Change screen");
  const stillRunning = await command({ _tag: "read", sessionId });
  assert.equal(stillRunning.phase, "running");
  assert.deepEqual(stillRunning.captureGaps, []);
  receipt.coverage.lossLeavesSemanticInput = true;
  await click("Reconnect device stream");
  await control(
    "browser",
    "wait",
    "--text",
    "Live device display",
    "--timeout-ms",
    "60000"
  );
  await snapshot("reconnected");
  receipt.coverage.reconnect = true;
  await click("Close session");
  const closed = await command({ _tag: "read", sessionId });
  assert.equal(closed.phase, "closed");
  assert.equal(
    await forwards(),
    baseline,
    "Stream forwards must return to baseline"
  );
  receipt.coverage.cleanup = true;
} catch (error) {
  receipt.blockers.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (sessionId) {
    const final = await command({ _tag: "read", sessionId });
    if (final.phase !== "closed") {
      await control(
        "browser",
        "goto",
        "--url",
        `${instance.mcpUrl}?android=${sessionId}`
      );
      await click("Close session");
    }
  }
  await execute("adb", [
    "-s",
    selection.device.serial,
    "uninstall",
    selection.environment.appId,
  ]);
  const restoredState = await deviceState();
  receipt.coverage.deviceStateRestored =
    JSON.stringify(restoredState) === JSON.stringify(originalState);
  receipt.coverage.forwardsRestored = (await forwards()) === baseline;
  if (
    !receipt.coverage.deviceStateRestored ||
    !receipt.coverage.forwardsRestored
  ) {
    receipt.blockers.push(
      "Device packages, input methods, or ADB forwards differ from the pre-install baseline."
    );
    process.exitCode = 1;
  }
  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2)
  );
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2)
  );
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
