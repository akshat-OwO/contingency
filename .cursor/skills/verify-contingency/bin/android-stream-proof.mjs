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
    startingState: "text Stream fixture ready is visible",
  },
  helperConsent: "none",
  outcomes: [{ name: "Stream fixture ready", role: "text" }],
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
const prepareName =
  selection.device.kind === "physical"
    ? "Prepare selected device"
    : "Prepare selected emulator";
const flowSkillName = `android-stream-${process.pid}`;
const receipt = {
  blockers: [],
  coverage: {},
  device: {
    api: selection.device.api,
    kind: physical ? "physical" : "emulator",
    model: physical ? selection.device.model : selection.device.avd,
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
  await openAndroidSheet(control, selection, flowSkillName, snapshot);
  const sessions = await tool("agent_android_sessions_list", {});
  sessionId = sessions.find(
    (session) => session.flowSkillName === flowSkillName
  )?.id;
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
  if (physical) {
    await control(
      "browser",
      "wait",
      "--role",
      "region",
      "--name",
      "Clear Target App data"
    );
    await snapshot("fixture-data-consent");
    await control(
      "browser",
      "android-allow-request",
      "--name",
      "Clear Target App data"
    );
  }
  await wait(prepareName);
  await click(prepareName);
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
  await click("Start recording");
  await wait("Stop recording");
  await androidComment(
    control,
    "Record public stream changes; secure content must remain hidden."
  );
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
    "Device stream lost.",
    "--timeout-ms",
    "60000"
  );
  await snapshot("stream-lost");
  const stillRunning = await command({ _tag: "read", sessionId });
  assert.equal(stillRunning.phase, "running");
  assert.deepEqual(stillRunning.captureGaps, []);
  receipt.coverage.lossPreservesSession = {
    captureGaps: [],
    inputUnavailableUntilReconnect: true,
    running: true,
  };
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
  await click("Stop recording");
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
    const owned = await tool("agent_android_sessions_list", {});
    for (const session of owned.filter(
      (entry) =>
        entry.flowSkillName === flowSkillName &&
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
