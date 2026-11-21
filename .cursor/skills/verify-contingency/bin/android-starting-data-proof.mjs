// Device mutations and Workspace gestures must run in sequence.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { chooseTargetApp, closeNativeSession } from "./android-ui.mjs";

/**
 * Starting Data and Device Erase on a proof-owned emulator (ADR 0081).
 *
 * Phases run separately so the operator can seed the fixture marker through
 * the Device panel between them:
 *   boot   Start the proof AVD from the Android start card; require that the
 *          pre-existing emulator offers no Erase.
 *   keep   Teach with Keep and require the stored marker.
 *   clear  Teach with Clear: confirm (the dialog is the consent), require fresh data,
 *          then require a fresh screen again after Start recording.
 *   erase  File an agent erase request through MCP, answer it in Workspace,
 *          and require the fixture to be gone from the restarted emulator.
 */
const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const [phase] = process.argv.slice(2);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const avd = process.env.CONTINGENCY_ANDROID_AVD;
const foreign = process.env.CONTINGENCY_ANDROID_FOREIGN_AVD;
assert.ok(
  ["boot", "keep", "clear", "erase"].includes(phase),
  "Pass a phase: boot, keep, clear, or erase."
);
assert.ok(directory && avd && foreign, "Supply the instance and both AVDs.");
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start MCP for this instance first.");
const evidence = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/android-starting-data"
);
await mkdir(evidence, { recursive: true });
const appId = "dev.contingency.physicalfixture";
const receipt = { avd, foreign, phase };
const journal = [];
const run = async (file, args) => {
  const result = await execute(file, args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  journal.push({ command: [file, ...args], stdout: result.stdout });
  return result.stdout.trim();
};
const control = (...args) =>
  run(path.join(import.meta.dirname, "control-contingency"), args);
const tool = async (name, params) =>
  JSON.parse(
    await run(path.join(import.meta.dirname, "control-contingency"), [
      "mcp",
      "call",
      "--tool",
      name,
      "--params",
      JSON.stringify(params),
    ])
  );
const sessions = () =>
  tool("agent_device_sessions_list", { platform: "android" });
const read = (id) =>
  tool("agent_device_workspace", {
    command: { _tag: "read", sessionId: id },
    platform: "android",
  });
/** The serial adb reports for a running AVD, or undefined. */
const serialOf = async (name) => {
  const listing = await run("adb", ["devices"]);
  for (const line of listing.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/u);
    if (serial?.startsWith("emulator-") && state === "device") {
      const reported = await run("adb", ["-s", serial, "emu", "avd", "name"]);
      if (reported.split("\n")[0]?.trim() === name) {
        return serial;
      }
    }
  }
  return null;
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordVideo: { dir: evidence, size: { height: 800, width: 1280 } },
  viewport: { height: 800, width: 1280 },
});
const page = await context.newPage();
const video = page.video();
const button = (name) => page.getByRole("button", { exact: true, name });
const click = (name) => button(name).click();
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
// `?android=new` opens the home with the Teach on Android start card open.
const openCard = async () => {
  await page.goto(`${instance.mcpUrl}?android=new`);
  await page
    .getByRole("form", { exact: true, name: "Teach on Android" })
    .waitFor();
};
// The card's Setup section starts collapsed; open it once.
const openSetup = async () => {
  const setup = page.getByRole("button", { name: /^Setup/u });
  if ((await setup.getAttribute("aria-expanded")) !== "true") {
    await setup.click();
  }
};
const nodes = (session) =>
  session.observation?.nodes.map((node) => node.name) ?? [];
const deviceField = page.getByRole("combobox", {
  exact: true,
  name: "Device",
});
/**
 * Opens the Device field and picks the option whose name matches. When no
 * such device is listed in time, it closes the field and answers false.
 */
const pickDevice = async (pattern, timeout = 60_000) => {
  const shown = await deviceField.waitFor({ timeout }).then(
    () => true,
    () => false
  );
  if (!shown) {
    return false;
  }
  await deviceField.click();
  // A device adb reports offline lists as a disabled option; wait for it to
  // be enabled, or let the caller refresh.
  const option = page.getByRole("option", { disabled: false, name: pattern });
  if (
    await option.waitFor({ timeout }).then(
      () => true,
      () => false
    )
  ) {
    await option.click();
    return true;
  }
  await page.keyboard.press("Escape");
  return false;
};
/** The hint row under the Device field, for the device it shows. */
const hint = (name) => page.getByRole("group", { exact: true, name });
let flowName;
const teach = async (startingData) => {
  const serial = await serialOf(avd);
  assert.ok(serial, `${avd} is not running.`);
  flowName = `starting-data-${startingData}-${process.pid}`;
  await openCard();
  await page
    .getByRole("textbox", { exact: true, name: "Flow name" })
    .fill(flowName);
  // The option reads `<AVD> · Android 16 emulator-5554`.
  const option = new RegExp(serial, "u");
  let picked = await pickDevice(option, 20_000);
  for (let refresh = 0; refresh < 12 && !picked; refresh += 1) {
    receipt.listingRetries = (receipt.listingRetries ?? 0) + 1;
    await click("Refresh devices");
    picked = await pickDevice(option, 20_000);
  }
  assert.ok(picked, `The Device field does not list ${serial}.`);
  // An interrupted listing can fail a concurrent one (a pre-existing
  // discovery race outside this proof), so the Target App combobox's listing
  // is retried, never setup.
  const chosen = await chooseTargetApp(page, appId);
  receipt.listingRetries = (receipt.listingRetries ?? 0) + chosen.refreshes;
  // Clear resets runtime grants, so the fixture's launch-time notification
  // request needs a declared grant applied after the clear.
  await openSetup();
  await page
    .getByRole("radio", {
      exact: true,
      name: "Notifications: Grant before start",
    })
    .click();
  await page
    .getByRole("radio", {
      name:
        startingData === "clear" ? /^Clear app data/u : /^Keep current data/u,
    })
    .check();
  await click("Start teaching");
  const dialog = page.getByRole("dialog", {
    exact: true,
    name: "Prepare and open app?",
  });
  await dialog.waitFor();
  const text = await dialog.textContent();
  assert.equal(
    text.includes(
      "This removes Contingency device proof's sign-in and local data now"
    ),
    startingData === "clear"
  );
  await capture(`${startingData}-confirmation`);
  await click("Confirm preparation");
  return serial;
};
const session = async () => {
  const listed = await sessions();
  const found = listed.find((entry) => entry.flowName === flowName);
  assert.ok(found, `No session for ${flowName}.`);
  return read(found.id);
};
// Close session is in the Agent Session picker; a closed Teaching session
// offers New session.
const close = async () => {
  await closeNativeSession(page);
  await button("New session").waitFor({ timeout: 60_000 });
};
try {
  if (phase === "boot") {
    await openCard();
    assert.ok(
      await pickDevice(new RegExp(`^${foreign} `, "u")),
      `The Device field does not list ${foreign}.`
    );
    // The hint row of the device it shows carries the refusal note.
    await hint(foreign)
      .getByText("Stop this device to erase it.", { exact: true })
      .waitFor({ timeout: 60_000 });
    assert.equal(
      await page.getByRole("button", { name: `Erase ${foreign}` }).count(),
      0
    );
    receipt.foreignRefusesErase = true;
    await capture("boot-card");
    assert.ok(
      await pickDevice(new RegExp(`^${avd} `, "u")),
      `The Device field does not list ${avd}.`
    );
    await hint(avd)
      .getByRole("button", { exact: true, name: `Start ${avd}` })
      .click();
    // Once booted it is listed under its serial, and the stopped pick goes.
    await hint(avd).waitFor({ state: "detached", timeout: 240_000 });
    assert.ok(
      await pickDevice(new RegExp(`^${avd}(?: · .*)? emulator-`, "u")),
      `The Device field does not list the booted ${avd}.`
    );
    await hint(avd)
      .getByRole("button", { exact: true, name: `Erase ${avd}` })
      .waitFor({ timeout: 240_000 });
    receipt.serial = await serialOf(avd);
    assert.ok(receipt.serial);
    receipt.ownedOffersErase = true;
    await capture("boot-owned");
  }
  if (phase === "keep") {
    await teach("keep");
    await button("Start recording").waitFor({ timeout: 120_000 });
    const kept = await session();
    assert.ok(nodes(kept).includes("Existing fixture data"));
    assert.equal(kept.pendingDecision, null);
    assert.equal(kept.selection.setup.startingData, "keep");
    receipt.keptMarker = true;
    await capture("keep-prepared");
    await close();
  }
  if (phase === "clear") {
    const serial = await teach("clear");
    // Confirm preparation is the user's consent: its dialog names the clear,
    // and no second decision follows on this Workspace path.
    await button("Start recording").waitFor({ timeout: 120_000 });
    const cleared = await session();
    assert.equal(cleared.pendingDecision, null);
    assert.equal(cleared.selection.setup.startingData, "clear");
    assert.ok(nodes(cleared).includes("Fresh fixture data"));
    receipt.clearedAtPreparation = true;
    await capture("clear-prepared");
    // Dirty the app again with Forwarded Input, as a user would in the
    // Workspace, then require Start recording to clear it.
    await control(
      "browser",
      "goto",
      "--url",
      `${instance.mcpUrl}?android=${cleared.id}`
    );
    await control(
      "browser",
      "android-pick",
      "--session-id",
      cleared.id,
      "--role",
      "button",
      "--name",
      "Store fixture data"
    );
    let dirtied = await session();
    for (
      let attempt = 0;
      attempt < 20 && !nodes(dirtied).includes("Existing fixture data");
      attempt += 1
    ) {
      dirtied = await session();
    }
    assert.ok(nodes(dirtied).includes("Existing fixture data"));
    await click("Start recording");
    await button("Stop recording").waitFor({ timeout: 120_000 });
    let recording = await session();
    for (
      let attempt = 0;
      attempt < 20 && !nodes(recording).includes("Fresh fixture data");
      attempt += 1
    ) {
      recording = await session();
    }
    assert.ok(nodes(recording).includes("Fresh fixture data"));
    const packages = await run("adb", [
      "-s",
      serial,
      "shell",
      "pm",
      "list",
      "packages",
      appId,
    ]);
    assert.match(packages, new RegExp(`package:${appId}`, "u"));
    receipt.clearedAtRecording = true;
    receipt.appStaysInstalled = true;
    await capture("clear-recording");
    await click("Stop recording");
    await close();
  }
  if (phase === "erase") {
    const serial = await serialOf(avd);
    assert.ok(serial);
    const requested = await tool("agent_device_workspace", {
      command: {
        _tag: "device-erase-request",
        device: avd,
        operationId: `erase-${process.pid}`,
      },
      platform: "android",
    });
    receipt.request = requested;
    // A request alone erases nothing.
    assert.match(
      await run("adb", [
        "-s",
        serial,
        "shell",
        "pm",
        "list",
        "packages",
        appId,
      ]),
      new RegExp(`package:${appId}`, "u")
    );
    await openCard();
    // Show the proof AVD, so its hint row reports the erase.
    assert.ok(
      await pickDevice(new RegExp(`^${avd}(?: · .*)? emulator-`, "u")),
      `The Device field does not list ${avd}.`
    );
    const banner = page.getByRole("region", {
      exact: true,
      name: "Device Erase request",
    });
    await banner.waitFor({ timeout: 60_000 });
    assert.match(await banner.textContent(), new RegExp(`erase ${avd}`, "u"));
    await capture("erase-request");
    await banner
      .getByRole("button", { exact: true, name: "Erase device" })
      .click();
    const confirm = page.getByRole("alertdialog", { name: `Erase ${avd}?` });
    await confirm.waitFor();
    await capture("erase-confirmation");
    await confirm
      .getByRole("button", { exact: true, name: "Erase device" })
      .click();
    const erasing = hint(avd).getByText("Erasing…");
    await erasing.waitFor({ timeout: 30_000 });
    await erasing.waitFor({ state: "detached", timeout: 300_000 });
    // It may start again under another serial, which drops the pick.
    assert.ok(
      await pickDevice(new RegExp(`^${avd}(?: · .*)? emulator-`, "u"), 120_000),
      `The Device field does not list the erased ${avd}.`
    );
    await hint(avd)
      .getByRole("button", { exact: true, name: `Erase ${avd}` })
      .waitFor({ timeout: 300_000 });
    assert.equal(await banner.count(), 0);
    const after = await serialOf(avd);
    assert.ok(after, "The erased emulator did not start again.");
    const remaining = await run("adb", [
      "-s",
      after,
      "shell",
      "pm",
      "list",
      "packages",
      appId,
    ]);
    assert.equal(remaining, "");
    receipt.erasedSerial = after;
    receipt.fixtureRemoved = true;
    await capture("erase-done");
  }
  receipt.ok = true;
} finally {
  try {
    await writeFile(
      path.join(evidence, `${phase}-receipt.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    await writeFile(
      path.join(evidence, `${phase}-journal.json`),
      `${JSON.stringify(journal, null, 2)}\n`
    );
    if (receipt.ok !== true) {
      // Open the Device field, so the capture lists every device.
      if ((await deviceField.count()) > 0) {
        await deviceField.click().catch(() => null);
      }
      await capture(`${phase}-failure`);
    }
  } finally {
    await context.close();
    await video.saveAs(path.join(evidence, `${phase}.webm`));
    await video.delete();
    await browser.close();
  }
}
console.log(JSON.stringify(receipt));
