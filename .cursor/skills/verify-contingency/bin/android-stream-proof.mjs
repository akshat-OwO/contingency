// Workspace gestures and navigation must run in order on the selected device.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start this instance's MCP broker first.");
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/android-stream"
);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const journal = [];
const control = (...args) =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        execute(
          process.execPath,
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
const command = (input) =>
  tool("agent_device_workspace", { command: input, platform: "android" });
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
// The canvas is visible only while it shows decoded frames.
const liveDisplay = () =>
  control(
    "browser",
    "wait",
    "--role",
    "application",
    "--name",
    "Selected device live display",
    "--partial",
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
    avd: process.env.CONTINGENCY_ANDROID_AVD,
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial: process.env.CONTINGENCY_ANDROID_SERIAL,
  },
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.contingency.physicalfixture",
    startingState: "text Stream fixture ready is visible",
  },
  helperConsent: "none",
  outcomes: [{ name: "Stream fixture ready", role: "text" }],
  setup: {
    activity: "dev.contingency.physicalfixture/.StreamActivity",
    conditions: [{ name: "Stream fixture ready", role: "text" }],
    kind: "restart-activity",
  },
};
assert.ok(
  Object.values(selection.device).every((value) => value !== undefined),
  "Supply the explicitly authorized device declarations."
);
const flowName = `android-stream-${process.pid}`;
const receipt = {
  blockers: [],
  coverage: {},
  device: {
    api: selection.device.api,
    kind: "emulator",
    model: selection.device.avd,
  },
  entryPoint: "Workspace Android",
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
  await openAndroidSheet(control, selection, flowName, snapshot);
  const sessions = await tool("agent_device_sessions_list", {
    platform: "android",
  });
  sessionId = sessions.find((session) => session.flowName === flowName)?.id;
  assert.ok(sessionId);
  const selected = await command({ _tag: "read", sessionId });
  assert.deepEqual(selected.selection.device, selection.device);
  assert.equal(
    selected.selection.setup.activity,
    selection.setup.activity,
    "The fixture launcher must open StreamActivity; exported activities without a launcher are not selectable."
  );
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${sessionId}`
  );

  await wait("Start recording");

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
  await androidPick(control, sessionId, "button", "Change screen");
  await liveDisplay();
  const second = await check(first.frame);
  assert.notEqual(second.frame, first.frame);
  receipt.coverage.changedFrame = true;
  await snapshot("changed-frame");
  await click("Start recording");
  await wait("Stop recording");
  await androidComment(
    control,
    "Record public stream changes; secure content must remain hidden."
  );
  const processTable = async () => {
    const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,command="]);
    return stdout.split("\n").flatMap((line) => {
      const match = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+(?<command>.+)$/u.exec(
        line
      )?.groups;
      return match
        ? [
            {
              command: match.command,
              parent: Number(match.parent),
              pid: Number(match.pid),
            },
          ]
        : [];
    });
  };
  // Stream workers started by this instance's MCP server, never another one.
  const streamWorkers = async () => {
    const table = await processTable();
    return table
      .filter(
        (row) =>
          row.command.includes("/android-stream-worker.js") &&
          table.some(
            (owner) =>
              owner.pid === row.parent && owner.parent === instance.mcpPid
          )
      )
      .map((row) => row.pid);
  };
  const workers = await streamWorkers();
  assert.equal(
    workers.length,
    1,
    "One stream worker must belong to this MCP process"
  );
  process.kill(workers[0], "SIGKILL");
  // The viewer reconnects on its own, and the server starts a fresh worker.
  let replacement;
  for (
    let attempt = 0;
    attempt < 60 && replacement === undefined;
    attempt += 1
  ) {
    await delay(1000);
    const current = await streamWorkers();
    replacement = current.find((pid) => pid !== workers[0]);
  }
  assert.ok(replacement, "The viewer must reconnect to a fresh stream worker");
  await liveDisplay();
  await snapshot("reconnected");
  const stillRunning = await command({ _tag: "read", sessionId });
  assert.equal(stillRunning.phase, "running");
  assert.deepEqual(stillRunning.captureGaps, []);
  receipt.coverage.lossPreservesSession = {
    captureGaps: [],
    running: true,
  };
  receipt.coverage.reconnect = { automatic: true };
  // A stalled tab (for example under swap pressure) resumes to a burst of
  // queued frames. Pause only this instance's driver browser and its children.
  const table = await processTable();
  const driver = new Set([instance.driverPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      if (driver.has(row.parent) && !driver.has(row.pid)) {
        driver.add(row.pid);
        grew = true;
      }
    }
  }
  // A Chromium child may exit between listing and signalling; skip it.
  const signalDriver = (name) => {
    for (const pid of driver) {
      try {
        process.kill(pid, name);
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          throw error;
        }
      }
    }
  };
  try {
    signalDriver("SIGSTOP");
    await delay(10_000);
  } finally {
    signalDriver("SIGCONT");
  }
  await liveDisplay();
  receipt.coverage.stallRecovers = { stalledSeconds: 10 };
  await androidPick(control, sessionId, "button", "Change screen");
  await snapshot("recorded-change");
  await androidPick(control, sessionId, "button", "Show secure window");
  await control(
    "browser",
    "wait",
    "--text",
    "Secure window, not visible",
    "--timeout-ms",
    "60000"
  );
  await snapshot("secure-window");
  receipt.coverage.secureWindow = {
    hidden: true,
    recovery: "Close session; no hidden canvas input",
  };
  // A secure window pauses the session, so recording cannot be stopped.
  const paused = await command({ _tag: "read", sessionId });
  assert.equal(paused.phase, "paused");
  await wait("Close session");
  await androidIdle(control);
  await click("Close session");
  await wait("New session");
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
  try {
    const owned = await tool("agent_device_sessions_list", {
      platform: "android",
    });
    for (const session of owned.filter(
      (entry) =>
        entry.flowName === flowName &&
        ["pending", "running", "paused"].includes(entry.phase)
    )) {
      await control(
        "browser",
        "goto",
        "--url",
        `${instance.mcpUrl}?android=${session.id}`
      );
      await click("Close session");
      await wait("New session");
      const closedSession = await command({
        _tag: "read",
        sessionId: session.id,
      });
      assert.equal(closedSession.phase, "closed");
    }
  } catch (error) {
    receipt.blockers.push(`Owned session cleanup failed: ${String(error)}`);
    process.exitCode = 1;
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
