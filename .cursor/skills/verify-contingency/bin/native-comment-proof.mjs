// Workspace gestures run in order on the one selected device.
/* oxlint-disable eslint/no-await-in-loop */
/**
 * Proves Attach element on native Teaching comments (ADR 0088) on Android or
 * iOS: one comment attached through Screen elements, one through the picker
 * over the device screen, both read back from the Teaching Timeline.
 *
 * Usage: `vpx native-comment-proof.mjs android`, or for iOS set
 * `CONTINGENCY_IOS_PROOF_SCRIPT` to this file on `ios-workspace-attempt.sh`; Android reads the
 * `CONTINGENCY_ANDROID_*` declarations and needs the working checkout
 * fixture installed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  androidIdle,
  nativeComment,
  openAndroidStartCard,
} from "./android-ui.mjs";
import { iosRpc } from "./ios-workspace-rpc.mjs";

// `ios-workspace-attempt.sh` runs a proof without arguments.
const platform =
  process.argv[2] ??
  (process.env.CONTINGENCY_IOS_SELECTED === undefined ? undefined : "ios");
assert.ok(platform === "android" || platform === "ios", "Pass android or ios.");
const root = path.resolve(import.meta.dirname, "../../../..");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(directory, "Set CONTINGENCY_VERIFY_DIR to the owned instance.");
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start this instance's MCP broker first.");
const artifacts = path.join(
  root,
  process.env.CONTINGENCY_IOS_PROOF_ARTIFACTS ??
    `.cursor/skills/verify-contingency/artifacts/native-comment-${platform}`
);
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
const journal = [];
const control = async (...args) => {
  const { stdout } = await execute(
    process.execPath,
    [path.join(import.meta.dirname, "control-contingency"), ...args],
    { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 }
  );
  journal.push({ args, stdout: stdout.slice(0, 2000) });
  return stdout;
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
const button = (name) =>
  control("browser", "click", "--role", "button", "--name", name);
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
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `native-comment-proof-${process.pid}-${sequence}`;
};
const flowName = `native-comment-${platform}-${process.pid}`;
const receipt = { blockers: [], coverage: {}, flowName, platform };

const fixture =
  platform === "ios"
    ? {
        keyboard: { name: "Login name", role: "text-field" },
        pointer: { name: "Sign in privately", role: "button" },
      }
    : {
        keyboard: { name: "Shopper name", role: "text-field" },
        pointer: { name: "Sign in", role: "button" },
      };

/** The session as the user's Workspace reads it. */
const read = (sessionId) =>
  platform === "ios"
    ? iosRpc(instance.mcpUrl, "ios.workspace.command", {
        command: { _tag: "read", sessionId },
        source: "user",
      })
    : tool("agent_device_workspace", {
        command: { _tag: "read", sessionId },
        platform: "android",
      });
const showing = (session, { name, role }) =>
  session.observation?.nodes.find(
    (node) => node.role === role && node.name === name && !node.covered
  );
/** Waits until the Workspace's own observation shows the element. */
const until = async (sessionId, element) => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const session = await read(sessionId);
    const node = showing(session, element);
    if (node !== undefined) {
      return { node, session };
    }
    assert.ok(Date.now() < deadline, `${element.name} never showed.`);
    await sleep(1000);
  }
};
const settle = () =>
  platform === "android"
    ? androidIdle(control)
    : control(
        "browser",
        "wait",
        "--role",
        "form",
        "--name",
        "Comment",
        "--state",
        "hidden",
        "--timeout-ms",
        "30000"
      );

const startIos = async () => {
  const selected = process.env.CONTINGENCY_IOS_SELECTED;
  const appPath = process.env.CONTINGENCY_IOS_FIXTURE;
  assert.ok(selected && appPath, "Run through ios-workspace-attempt.sh.");
  await control("browser", "goto", "--url", instance.mcpUrl);
  await button("Start an iOS session");
  await control("browser", "wait", "--role", "form", "--name", "Teach on iOS");
  await fill("Flow name", flowName);
  const devices = await iosRpc(instance.mcpUrl, "ios.devices.list", {});
  const device = devices.find((entry) => entry.udid === selected);
  assert.ok(device, "The proof-owned simulator must be discovered.");
  await control(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    device.name,
    "--partial",
    "true"
  );
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
  await control("browser", "ios-click", "--name", "Start teaching");
  const list = await iosRpc(instance.mcpUrl, "ios.workspace.list", {});
  const session = list.find((entry) => entry.flowName === flowName);
  assert.ok(session);
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?ios=${session.id}`
  );
  await control("browser", "ios-click", "--name", "Allow");
  await control("browser", "ios-click", "--name", "Prepare selected simulator");
  return session.id;
};
const startAndroid = async () => {
  const selection = {
    device: {
      api: 36,
      avd: process.env.CONTINGENCY_ANDROID_AVD,
      fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
      host: "local",
      serial: process.env.CONTINGENCY_ANDROID_SERIAL,
    },
    environment: { appId: "dev.contingency.checkout" },
    outcomes: [{ name: "Catalog", role: "group" }],
    setup: { conditions: [{ name: "Fixture Shop sign in", role: "group" }] },
  };
  assert.ok(
    Object.values(selection.device).every((value) => value !== undefined),
    "Supply the explicitly authorized device declarations."
  );
  await control("browser", "goto", "--url", instance.mcpUrl);
  await openAndroidStartCard(control, selection, flowName, snapshot);
  const listed = await tool("agent_device_sessions_list", {
    platform: "android",
  });
  const session = listed.find(
    (entry) => entry.flowName === flowName && entry.kind === "teaching"
  );
  assert.ok(session);
  return session.id;
};

/** Attaches `element` by clicking it on the picker over the device screen. */
const pointerComment = async (sessionId, element, text) => {
  await button("Comment");
  await button("Attach element");
  await control(
    "browser",
    "wait",
    "--role",
    "region",
    "--name",
    "Screen elements"
  );
  const { node, session } = await until(sessionId, element);
  const { bounds } = node;
  assert.ok(bounds, `${element.name} has no bounds to aim at.`);
  const fx = (bounds.x + bounds.width / 2) / session.observation.width;
  const fy = (bounds.y + bounds.height / 2) / session.observation.height;
  await control(
    "browser",
    "mouse",
    "--selector",
    '[data-slot="element-picker"]',
    "--fx",
    String(fx),
    "--fy",
    String(fy),
    "--click",
    "true"
  );
  await control("browser", "wait", "--text", "Change element");
  await snapshot("pointer-attached");
  await fill("Comment", text);
  await button("Add comment");
};

let sessionId;
try {
  sessionId = platform === "ios" ? await startIos() : await startAndroid();
  await control(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Start recording",
    "--timeout-ms",
    "180000"
  );
  await button("Start recording");
  await control(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Stop recording"
  );
  await until(sessionId, fixture.keyboard);
  // Screen elements is the picker's keyboard path.
  await nativeComment(
    control,
    `The ${fixture.keyboard.name} field takes public fixture text.`,
    fixture.keyboard.name
  );
  await settle();
  receipt.coverage.keyboardAttach = true;
  await until(sessionId, fixture.pointer);
  await pointerComment(
    sessionId,
    fixture.pointer,
    `${fixture.pointer.name} finishes signing in.`
  );
  await settle();
  receipt.coverage.pointerAttach = true;
  await snapshot("comments-added");
  await button("Stop recording");
  const deadline = Date.now() + 120_000;
  let stopped = await read(sessionId);
  while (stopped.captureState?._tag !== "ready") {
    assert.ok(Date.now() < deadline, "The recording never became ready.");
    await sleep(1000);
    stopped = await read(sessionId);
  }
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
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  const comments = timeline.entries.filter(
    (entry) => entry._tag === "instruction"
  );
  assert.deepEqual(
    comments.map((entry) => entry.target),
    [fixture.keyboard, fixture.pointer].map(
      ({ name, role }) => `${role} "${name}"`
    )
  );
  for (const entry of comments) {
    assert.equal(entry.element?.platform, platform);
    assert.ok(entry.element?.observationId);
    assert.ok(entry.element?.bounds);
  }
  receipt.coverage.timeline = comments.map((entry) => ({
    element: entry.element,
    target: entry.target,
    text: entry.text,
  }));
} catch (error) {
  receipt.blockers.push(String(error?.stack ?? error));
  await snapshot("failure").catch((snapshotError) =>
    receipt.blockers.push(`failure snapshot: ${String(snapshotError)}`)
  );
  throw error;
} finally {
  if (sessionId !== undefined) {
    // Teaching is user-led, so the agent tool cannot close it.
    await (
      platform === "ios"
        ? iosRpc(instance.mcpUrl, "ios.workspace.command", {
            command: { _tag: "close", operationId: operation(), sessionId },
            source: "user",
          })
        : control("browser", "native-close")
    ).catch((error) => receipt.blockers.push(`close: ${String(error)}`));
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
process.stdout.write(`native comment proof passed on ${platform}\n`);
