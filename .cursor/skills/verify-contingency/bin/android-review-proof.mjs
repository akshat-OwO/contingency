/* oxlint-disable eslint/no-await-in-loop -- Device and Workspace gestures run in order. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { androidPick, openAndroidSheet } from "./android-ui.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(directory, "Launch an owned verification instance first.");
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
assert.match(
  serial ?? "",
  /^emulator-\d+$/u,
  "This proof only uses an authorized emulator."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start the isolated MCP broker first.");
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/android-review"
);
await mkdir(artifacts, { recursive: true });
const journal = [];
const control = async (...args) => {
  const result = await execute(
    "nub",
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 8 * 1024 * 1024 }
  );
  journal.push({ args, stdout: result.stdout });
  return result.stdout;
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
let sequence = 0;
const command = (input) => {
  sequence += 1;
  return tool("agent_device_workspace", {
    command:
      input._tag === "read" || input._tag === "observe"
        ? input
        : { operationId: `review-${process.pid}-${sequence}`, ...input },
    platform: "android",
  });
};
const adb = async (...args) => {
  const result = await execute("adb", ["-s", serial, ...args]);
  return result.stdout.trim();
};
const click = (name) =>
  control("browser", "click", "--role", "button", "--name", name);
const wait = (role, name) =>
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
const snapshot = async (name) => {
  await control(
    "browser",
    "snapshot",
    "--aria",
    "--path",
    `android-review/${name}.aria.txt`
  );
  await control(
    "browser",
    "screenshot",
    "--path",
    `android-review/${name}.png`
  );
};
const appId = "dev.contingency.physicalfixture";
const prefix = `review-permissions-${process.pid}`;
const receipt = { blockers: [], cleanup: {}, coverage: {} };
let installed = false;
try {
  assert.equal(
    await adb("shell", "pm", "list", "packages", appId),
    "",
    "The disposable fixture must not already exist."
  );
  await adb(
    "install",
    path.join(
      root,
      ".cursor/skills/verify-contingency/artifacts/android-physical/build-permissions/fixture.apk"
    )
  );
  installed = true;
  const device = {
    api: 36,
    avd: "Pixel_9",
    fingerprint: await adb("shell", "getprop", "ro.build.fingerprint"),
    host: "local",
    serial,
  };
  for (const decision of ["grant", "revoke"]) {
    assert.equal(
      await adb("shell", "pm", "clear", "--user", "0", appId),
      "Success"
    );
    const flowSkillName = `${prefix}-${decision}`;
    const selection = {
      device,
      environment: {
        androidVersion: "16",
        appBuild: "1",
        appId,
        permissions: [
          { decision, permission: "android.permission.POST_NOTIFICATIONS" },
        ],
        startingState: "text Fresh fixture data is visible",
      },
      helperConsent: "none",
      outcomes: [{ name: "Semantic action passed", role: "button" }],
      setup: {
        activity: `${appId}/.MainActivity`,
        conditions: [{ name: "Fresh fixture data", role: "text" }],
        kind: "restart-activity",
      },
    };
    await control("browser", "goto", "--url", instance.mcpUrl);
    await openAndroidSheet(control, selection, flowSkillName, (name) =>
      snapshot(`${decision}-${name}`)
    );
    const sessions = await tool("agent_device_sessions_list", {
      platform: "android",
    });
    const session = sessions.find(
      (entry) => entry.flowSkillName === flowSkillName
    );
    assert.ok(session);
    assert.deepEqual(
      session.selection.environment.permissions,
      selection.environment.permissions
    );
    assert.equal(session.selection.setup.activity, selection.setup.activity);
    await click("Prepare selected emulator");
    await wait("button", "Start recording");
    const prepared = await command({
      _tag: "observe",
      image: false,
      sessionId: session.id,
    });
    assert.equal(prepared.phase, "running");
    assert.ok(
      prepared.observation.nodes.some(
        (node) => node.name === "Fresh fixture data"
      )
    );
    const dump = await adb("shell", "dumpsys", "package", appId);
    const owner = dump
      .split(/(?=^\s*User \d+:)/mu)
      .find((section) => /^\s*User 0:/u.test(section));
    assert.ok(owner);
    assert.match(
      owner,
      new RegExp(
        `android\\.permission\\.POST_NOTIFICATIONS: granted=${decision === "grant" ? "true" : "false"}.*USER_FIXED`,
        "u"
      )
    );
    await snapshot(`${decision}-prepared`);
    await control(
      "browser",
      "goto",
      "--url",
      `${instance.mcpUrl}?android=${session.id}`
    );
    await androidPick(control, session.id, "button", "Verify semantic action");
    const activated = await command({
      _tag: "observe",
      image: false,
      sessionId: session.id,
    });
    assert.ok(
      activated.observation.nodes.some(
        (node) => node.name === "Semantic action passed"
      )
    );
    receipt.coverage[decision] = {
      permissionApplied: true,
      semanticPick: true,
      startingScreenReached: true,
    };
    if (decision === "grant") {
      await adb("shell", "am", "start", "-n", "com.android.settings/.Settings");
      await command({
        _tag: "observe",
        image: false,
        sessionId: session.id,
      }).catch((error) =>
        journal.push({ expectedOwnershipRefusal: error.message })
      );
      const paused = await command({ _tag: "read", sessionId: session.id });
      assert.equal(paused.phase, "paused");
      await control("browser", "goto", "--url", instance.mcpUrl);
      await click("Android");
      await wait("combobox", "Android Agent Session");
      await snapshot("empty-existing-sessions");
      await control(
        "browser",
        "click",
        "--role",
        "combobox",
        "--name",
        "Android Agent Session"
      );
      await control(
        "browser",
        "click",
        "--role",
        "option",
        "--name",
        `${flowSkillName} · Android Teaching`
      );
      await wait("button", "Recover same emulator");
      await snapshot("reopened-paused");
      await adb("shell", "am", "force-stop", appId);
      await adb("shell", "am", "start", "-n", selection.setup.activity);
      await click("Recover same emulator");
      await wait("button", "Start recording");
      receipt.coverage.reopenPaused = true;
    }
    await click("Close session");
    await wait("button", "New session");
    await control("browser", "goto", "--url", instance.mcpUrl);
    await click("Android");
    await wait("combobox", "Android Agent Session");
    await control(
      "browser",
      "click",
      "--role",
      "combobox",
      "--name",
      "Android Agent Session"
    );
    await control(
      "browser",
      "click",
      "--role",
      "option",
      "--name",
      `${flowSkillName} · Android Teaching`
    );
    await wait("button", "New session");
    await snapshot(`${decision}-reopened-summary`);
    receipt.coverage.reopenClosed = true;
  }
} catch (error) {
  receipt.blockers.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    for (const session of await tool("agent_device_sessions_list", {
      platform: "android",
    })) {
      if (
        session.flowSkillName.startsWith(prefix) &&
        ["pending", "running", "paused"].includes(session.phase)
      ) {
        await control(
          "browser",
          "goto",
          "--url",
          `${instance.mcpUrl}?android=${session.id}`
        );
        await wait("button", "Close session");
        await click("Close session");
        await wait("button", "New session");
      }
    }
    if (installed) {
      assert.equal(await adb("uninstall", appId), "Success");
      receipt.cleanup.fixtureUninstalled = true;
    }
  } catch (error) {
    receipt.blockers.push(
      `Cleanup: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2)
  );
  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2)
  );
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
