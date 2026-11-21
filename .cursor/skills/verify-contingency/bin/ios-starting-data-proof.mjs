// Simulator mutations and Workspace gestures must run in sequence.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { iosRpc } from "./ios-workspace-rpc.mjs";

/**
 * Starting Data and Device Erase on a proof-owned iPhone simulator
 * (ADR 0081). The operator creates, boots, and installs the login fixture on
 * the simulator named by CONTINGENCY_IOS_SELECTED.
 *   keep   Teach with Keep; a seeded container file and defaults key remain.
 *          The operator-booted simulator offers no Erase.
 *   clear  Teach with Clear: allow the clear-app-data decision, require both
 *          markers gone with the app installed, reseed, then require Start
 *          recording to clear them again.
 *   erase  With the simulator shut down, file an agent erase request through
 *          MCP, answer it in Workspace, and require the fixture gone from the
 *          simulator Contingency boots again.
 */
const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { chromium } = require("playwright-core");
const execute = promisify(execFile);
const [phase] = process.argv.slice(2);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const udid = process.env.CONTINGENCY_IOS_SELECTED;
assert.ok(
  ["keep", "clear", "erase"].includes(phase),
  "Pass a phase: keep, clear, or erase."
);
assert.ok(directory && udid, "Supply the instance and the proof simulator.");
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start MCP for this instance first.");
const evidence = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/ios-starting-data"
);
await mkdir(evidence, { recursive: true });
const bundleId = "dev.contingency.ioslogin";
const receipt = { phase, udid };
const journal = [];
const run = async (file, args) => {
  const result = await execute(file, args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  journal.push({ command: [file, ...args], stdout: result.stdout });
  return result.stdout.trim();
};
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
const container = () => simctl("get_app_container", udid, bundleId, "data");
/** Seeds a container file and a defaults key, as a signed-in app would. */
const seed = async () => {
  const data = await container();
  await mkdir(path.join(data, "Documents"), { recursive: true });
  await writeFile(path.join(data, "Documents/marker.txt"), "proof\n");
  await simctl(
    "spawn",
    udid,
    "defaults",
    "write",
    bundleId,
    "proofMarker",
    "-string",
    "kept"
  );
};
const markers = async () => {
  const data = await container();
  const file = await access(path.join(data, "Documents/marker.txt")).then(
    () => true,
    () => false
  );
  const defaults = await simctl(
    "spawn",
    udid,
    "defaults",
    "read",
    bundleId,
    "proofMarker"
  ).then(
    (value) => value === "kept",
    () => false
  );
  return { defaults, file };
};
const installed = async () => {
  const apps = await simctl("listapps", udid);
  return apps.includes(`"${bundleId}"`);
};
const deviceName = async () => {
  const listed = JSON.parse(await simctl("list", "devices", "-j"));
  for (const devices of Object.values(listed.devices)) {
    const found = devices.find((device) => device.udid === udid);
    if (found !== undefined) {
      return { name: found.name, state: found.state };
    }
  }
  throw new Error(`Simulator ${udid} is not listed.`);
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
// `?ios=new` opens the home with the Teach on iOS start card open.
const openCard = async () => {
  await page.goto(`${instance.mcpUrl}?ios=new`);
  await page.getByRole("form", { exact: true, name: "Teach on iOS" }).waitFor();
};
// The card's Setup section starts collapsed; open it once.
const openSetup = async () => {
  const setup = page.getByRole("button", { name: /^Setup/u });
  if ((await setup.getAttribute("aria-expanded")) !== "true") {
    await setup.click();
  }
};
const simulatorField = page.getByRole("combobox", {
  exact: true,
  name: "Simulator",
});
/** Opens the Simulator field and picks the option whose name matches. */
const pickSimulator = async (pattern, timeout = 60_000) => {
  // A refreshed simulator list re-renders the field and closes its listbox,
  // so open it again until the option shows.
  const option = page.getByRole("option", { name: pattern });
  const deadline = Date.now() + timeout;
  for (;;) {
    await simulatorField.click({ timeout });
    const shown = await option.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false
    );
    if (shown) {
      await option.click({ timeout: 10_000 });
      return;
    }
    assert.ok(Date.now() < deadline, `No simulator option ${pattern}.`);
    // Escape with the listbox already closed would close the start card.
    if ((await simulatorField.getAttribute("aria-expanded")) === "true") {
      await page.keyboard.press("Escape");
    }
  }
};
/** The hint row under the Simulator field, for the simulator it shows. */
const hint = (name) => page.getByRole("group", { exact: true, name });
let flowName;
const session = async () => {
  const listed = await iosRpc(instance.mcpUrl, "ios.workspace.list", {});
  const found = listed.find((entry) => entry.flowName === flowName);
  assert.ok(found, `No session for ${flowName}.`);
  return found;
};
/** Closes this phase's session and waits until the host reports it closed. */
const close = async () => {
  await click("Close session");
  const closing = flowName;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // A closed session leaves the live list.
    const listed = await iosRpc(instance.mcpUrl, "ios.workspace.list", {});
    if (
      !listed.some(
        (entry) => entry.flowName === closing && entry.phase !== "closed"
      )
    ) {
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${flowName} did not close.`);
};
const teach = async (startingData) => {
  const { name } = await deviceName();
  flowName = `ios-starting-data-${startingData}-${process.pid}`;
  await openCard();
  await page
    .getByRole("textbox", { exact: true, name: "Flow name" })
    .fill(flowName);
  // A booted simulator's option reads its runtime after its name.
  await pickSimulator(new RegExp(`^${name} iOS `, "u"));
  // The operator booted this simulator, so this process may not erase it.
  await hint(name)
    .getByText("Stop this device to erase it.", { exact: true })
    .waitFor({ timeout: 60_000 });
  receipt.unownedRefusesErase = true;
  await page
    .getByRole("button", { name: new RegExp(`${bundleId} build`, "u") })
    .click({ timeout: 90_000 });
  await openSetup();
  await page
    .getByRole("radio", {
      name:
        startingData === "clear" ? /^Clear app data/u : /^Keep current data/u,
    })
    .check();
  await capture(`${startingData}-setup`);
  await click("Start teaching");
};
try {
  if (phase === "keep") {
    await seed();
    await teach("keep");
    await click("Prepare selected simulator");
    await button("Start recording").waitFor({ timeout: 180_000 });
    const kept = await session();
    assert.equal(kept.selection.setup.startingData, "keep");
    assert.deepEqual(await markers(), { defaults: true, file: true });
    receipt.keptMarkers = true;
    await capture("keep-prepared");
    await close();
  }
  if (phase === "clear") {
    await seed();
    assert.deepEqual(await markers(), { defaults: true, file: true });
    await teach("clear");
    // Agent-free iOS Teaching asks for the clear as its own decision.
    await page
      .getByText(/Clear dev\.contingency\.ioslogin's sign-in and local data/u)
      .waitFor({ timeout: 60_000 });
    const asked = await session();
    assert.equal(asked.selection.setup.startingData, "clear");
    // Nothing is cleared before the user answers.
    assert.deepEqual(await markers(), { defaults: true, file: true });
    await capture("clear-decision");
    await click("Allow");
    await click("Prepare selected simulator");
    await button("Start recording").waitFor({ timeout: 180_000 });
    assert.deepEqual(await markers(), { defaults: false, file: false });
    assert.equal(await installed(), true);
    receipt.clearedAtPreparation = true;
    receipt.appStaysInstalled = true;
    await capture("clear-prepared");
    await seed();
    assert.deepEqual(await markers(), { defaults: true, file: true });
    await click("Start recording");
    await button("Stop recording").waitFor({ timeout: 180_000 });
    assert.deepEqual(await markers(), { defaults: false, file: false });
    receipt.clearedAtRecording = true;
    await capture("clear-recording");
    await click("Stop recording");
    await close();
  }
  if (phase === "erase") {
    const { name, state } = await deviceName();
    assert.equal(state, "Shutdown", "Shut the proof simulator down first.");
    // listapps needs a booted simulator; Keep and Clear left the fixture
    // installed, so its bundle is still on disk.
    const bundles = path.join(
      process.env.HOME,
      "Library/Developer/CoreSimulator/Devices",
      udid,
      "data/Containers/Bundle/Application"
    );
    assert.match(
      await run("find", [bundles, "-maxdepth", "2", "-name", "IosLogin.app"]),
      /IosLogin\.app/u
    );
    receipt.request = JSON.parse(
      await run(path.join(import.meta.dirname, "control-contingency"), [
        "mcp",
        "call",
        "--tool",
        "agent_device_workspace",
        "--params",
        JSON.stringify({
          command: {
            _tag: "device-erase-request",
            device: udid,
            operationId: `erase-${process.pid}`,
          },
          platform: "ios",
        }),
      ])
    );
    await openCard();
    const banner = page.getByRole("region", {
      exact: true,
      name: "Device Erase request",
    });
    // The banner names the device once the simulator list has loaded.
    await banner
      .getByText(`The agent asks to erase ${name}.`, { exact: true })
      .first()
      .waitFor({ timeout: 60_000 });
    // An earlier attempt's request stays pending until the user answers it;
    // dismiss those so the newest request is the one answered.
    for (let count = await banner.count(); count > 1; count -= 1) {
      await banner
        .first()
        .getByRole("button", { exact: true, name: "Dismiss" })
        .click();
      await page.waitForFunction(
        (expected) =>
          document.querySelectorAll(
            'section[aria-label="Device Erase request"]'
          ).length === expected,
        count - 1
      );
      receipt.dismissed = (receipt.dismissed ?? 0) + 1;
    }
    await capture("erase-request");
    await banner
      .getByRole("button", { exact: true, name: "Erase device" })
      .click();
    const confirm = page.getByRole("alertdialog", { name: `Erase ${name}?` });
    await confirm.waitFor();
    await capture("erase-confirmation");
    await confirm
      .getByRole("button", { exact: true, name: "Erase device" })
      .click();
    // Contingency erased and booted it, so it owns it and still offers Erase.
    await pickSimulator(new RegExp(`^${name} iOS `, "u"), 300_000);
    await hint(name)
      .getByRole("button", { exact: true, name: `Erase ${name}` })
      .waitFor({ timeout: 300_000 });
    assert.equal(await banner.count(), 0);
    const after = await deviceName();
    assert.equal(after.state, "Booted");
    assert.equal(await installed(), false);
    receipt.fixtureRemoved = true;
    receipt.ownedAfterErase = true;
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
