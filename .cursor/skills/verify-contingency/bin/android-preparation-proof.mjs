// Device mutations and Workspace gestures must run in sequence.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const { androidHelperRelease } =
  await import("../../../../packages/cli/src/services/android-runtime-contract.ts");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const deviceCommand = process.env.CONTINGENCY_DEVICE_COMMAND;
const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
const apk = process.env.CONTINGENCY_ANDROID_APK;
const newerHelperApk = process.env.CONTINGENCY_ANDROID_NEWER_HELPER_APK;
assert.ok(
  directory && deviceCommand && serial && apk && newerHelperApk,
  "Supply the owned instance, device command, exact serial, fixture APK, and newer helper APK."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl);
const evidence = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/android-confirmed-preparation"
);
await mkdir(evidence, { recursive: true });
const journal = [];
const run = async (file, args) => {
  const result = await execute(file, args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  journal.push({
    command: [file, ...args],
    stderr: result.stderr,
    stdout: result.stdout,
  });
  return result.stdout.trim();
};
const control = (...args) =>
  run(path.join(import.meta.dirname, "control-contingency"), args);
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
const sessions = () =>
  tool("agent_device_sessions_list", { platform: "android" });
const liveCount = async () => {
  const listed = await sessions();
  return listed.filter((session) =>
    ["pending", "running", "paused"].includes(session.phase)
  ).length;
};
const read = (id) =>
  tool("agent_device_workspace", {
    command: { _tag: "read", sessionId: id },
    platform: "android",
  });
const adb = (...args) => run("adb", ["-s", serial, ...args]);
const helperVersion = () =>
  adb(
    "shell",
    "pm",
    "list",
    "packages",
    "--show-versioncode",
    "com.callstack.agentdevice.snapshothelper"
  );
const supportedHelper = async () => {
  const listing = await helperVersion();
  assert.ok(
    listing.includes(`versionCode:${androidHelperRelease.versionCode}`)
  );
  const location = await adb(
    "shell",
    "pm",
    "path",
    androidHelperRelease.packageName
  );
  assert.match(location, /^package:\/data\/app\//u);
  const digest = await adb(
    "shell",
    "sha256sum",
    location.slice("package:".length)
  );
  return digest.startsWith(androidHelperRelease.sha256);
};
const foreground = async () => {
  const dump = await adb("shell", "dumpsys", "activity", "activities");
  return dump
    .split("\n")
    .filter((line) =>
      /topResumedActivity=|launchFailed=false launchCount=/u.test(line)
    )
    .map((line) => line.replace(/ lastLaunchTime=.*$/u, ""))
    .join("\n");
};
const appId = "dev.contingency.physicalfixture";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordVideo: { dir: evidence, size: { height: 800, width: 1280 } },
  viewport: { height: 800, width: 1280 },
});
const page = await context.newPage();
const video = page.video();
const click = (name) => page.getByRole("button", { exact: true, name }).click();
const wait = (name) =>
  page.getByRole("button", { exact: true, name }).waitFor({ timeout: 90_000 });
const capture = async (name) => {
  await page.screenshot({
    animations: "disabled",
    path: path.join(evidence, `${name}.png`),
  });
  await writeFile(
    path.join(evidence, `${name}.aria.txt`),
    await page.locator("body").ariaSnapshot()
  );
};
let flowName;
const open = async (name, upload, starting) => {
  flowName = `${name}-${process.pid}`;
  console.log(`Opening ${flowName}`);
  await page.goto(`${instance.mcpUrl}?android=new`);
  await click("Open Android session");
  await page
    .getByRole("textbox", { exact: true, name: "Flow name" })
    .fill(flowName);
  await page.getByRole("button", { name: new RegExp(serial, "u") }).click();
  if (upload) {
    await page.getByLabel("Upload an .apk", { exact: true }).setInputFiles(apk);
    await page
      .getByText(/replaces build 1 with your consent/u)
      .waitFor({ timeout: 90_000 });
  } else {
    await page
      .getByRole("textbox", { name: "Search installed apps" })
      .fill(appId);
    await page
      .getByRole("button", { name: new RegExp(appId, "u") })
      .click({ timeout: 90_000 });
  }
  if (starting) {
    await click("Optional steps");
    await page
      .getByRole("textbox", { exact: true, name: "Starting screen element" })
      .fill(starting);
  }
  await click("Prepare and open app");
  const dialog = page.getByRole("dialog", {
    exact: true,
    name: "Prepare and open app?",
  });
  await dialog.waitFor();
  const text = await dialog.textContent();
  assert.match(text, /Pixel_9/u);
  assert.match(text, /newer helper/u);
  assert.equal(text.includes("Reinstall the selected APK"), upload);
  await capture(`${name}-confirmation`);
};
const selected = async () => {
  const listed = await sessions();
  const session = listed.find((entry) => entry.flowName === flowName);
  assert.ok(session);
  assert.equal(session.selection.device.serial, serial);
  return read(session.id);
};
const close = async () => {
  await click("Close session");
  await wait("New session");
  console.log("Closed session");
};
const receipt = {
  coverage: {},
  feature: "android-confirmed-preparation",
  serial,
};
try {
  await run(deviceCommand, ["open", appId]);
  let freshTree = await run(deviceCommand, ["snapshot", "-i"]);
  if (
    freshTree.includes(
      "Allow Contingency device proof to send you notifications?"
    )
  ) {
    const allow = /(?<target>@e\d+) \[button\] "Allow"/u.exec(freshTree)?.groups
      ?.target;
    assert.ok(allow);
    await run(deviceCommand, ["press", allow, "--settle"]);
    freshTree = await run(deviceCommand, ["snapshot", "-i"]);
  }
  const clear = /(?<target>@e\d+) \[button\] "Clear fixture marker"/u.exec(
    freshTree
  )?.groups?.target;
  assert.ok(clear);
  await run(deviceCommand, ["press", clear, "--settle"]);
  await run(deviceCommand, ["close"]);
  await adb("install", "--user", "0", "-r", newerHelperApk);
  const newerListing = await helperVersion();
  const newerCode = Number(
    /versionCode:(?<code>\d+)/u.exec(newerListing)?.groups?.code
  );
  assert.ok(
    newerCode > androidHelperRelease.versionCode,
    "The bound device command must seed a newer helper before this proof."
  );
  await open("preparation-retry", true, "Existing fixture data");
  const before = {
    foreground: await foreground(),
    helper: await helperVersion(),
  };
  await click("Cancel");
  assert.equal(await liveCount(), 0);
  assert.equal(await helperVersion(), before.helper);
  assert.equal(await foreground(), before.foreground);
  await click("Prepare and open app");
  await page.keyboard.press("Escape");
  assert.equal(await liveCount(), 0);
  assert.equal(await helperVersion(), before.helper);
  receipt.coverage.cancelAndEscape = true;
  await click("Prepare and open app");
  console.log("Confirming APK setup with newer helper");
  await click("Confirm preparation");
  await wait("Retry preparation");
  const failed = await selected();
  assert.equal(failed.phase, "paused");
  assert.match(failed.error, /starting/u);
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "Recover same emulator" })
      .count(),
    0
  );
  assert.equal(await supportedHelper(), true);
  receipt.failed = failed;
  await capture("failed-preparation");
  // Repair the persistent starting condition through the bound Device panel session.
  await run(deviceCommand, ["open", appId]);
  const tree = await run(deviceCommand, ["snapshot", "-i"]);
  const target = /(?<target>@e\d+) \[button\] "Store fixture data"/u.exec(tree)
    ?.groups?.target;
  assert.ok(target);
  await run(deviceCommand, ["press", target, "--settle"]);
  await run(deviceCommand, ["close"]);
  await click("Retry preparation");
  await wait("Start recording");
  const ready = await selected();
  assert.equal(ready.id, failed.id);
  assert.equal(ready.error, null);
  assert.equal(ready.phase, "running");
  assert.ok(
    ready.observation.nodes.some(
      (node) => node.name === "Existing fixture data"
    )
  );
  assert.equal(await supportedHelper(), true);
  assert.equal(await liveCount(), 1);
  receipt.ready = ready;
  receipt.coverage.newerHelperReplacement = true;
  receipt.coverage.apkReinstallPreservesData = true;
  receipt.coverage.sameSessionRetry = true;
  await capture("retried-prepared");
  await close();
  for (const helper of ["matching", "absent"]) {
    if (helper === "absent") {
      await adb("uninstall", "com.callstack.agentdevice.snapshothelper");
    }
    await open(`installed-app-${helper}`, false);
    await click("Confirm preparation");
    await wait("Start recording");
    const prepared = await selected();
    assert.equal(prepared.phase, "running");
    assert.equal(prepared.selection.apkPath, undefined);
    assert.ok(
      prepared.observation.nodes.some(
        (node) => node.name === "Existing fixture data"
      )
    );
    assert.equal(await supportedHelper(), true);
    receipt.coverage[`${helper}HelperInstalledApp`] = true;
    await capture(`installed-app-${helper}-prepared`);
    await close();
  }
  receipt.ok = true;
} finally {
  try {
    await capture("final-workspace");
    await writeFile(
      path.join(evidence, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    await writeFile(
      path.join(evidence, "journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`
    );
    if (
      await page
        .getByRole("button", { exact: true, name: "Close session" })
        .count()
    ) {
      await click("Close session");
    }
  } finally {
    try {
      await context.close();
      await video.saveAs(path.join(evidence, "workspace-preparation.webm"));
      await video.delete();
    } finally {
      await browser.close();
      try {
        await run(deviceCommand, ["close"]);
      } catch {
        // A closed device session has nothing left to release.
      }
    }
  }
}
console.log(JSON.stringify({ evidence, ...receipt.coverage, ok: receipt.ok }));
