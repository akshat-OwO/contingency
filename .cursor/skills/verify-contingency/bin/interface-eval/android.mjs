// Attached-device path only. This module never boots a device or installs an app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { json } from "./runtime.mjs";
import { workspace } from "./workspace.mjs";

export const androidPrerequisite = () => {
  const serial = process.env.CONTINGENCY_ANDROID_SERIAL;
  assert.ok(
    serial && process.env.CONTINGENCY_ANDROID_FIXTURE_INSTALL === "authorized",
    "Android prerequisite: explicitly authorize an attached checkout device with CONTINGENCY_ANDROID_SERIAL and CONTINGENCY_ANDROID_FIXTURE_INSTALL=authorized. No device or emulator is started."
  );
  try {
    execFileSync("lsof", ["-nP", "-iTCP:5037", "-sTCP:LISTEN"], {
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      "Android prerequisite: an existing adb server and explicitly selected attached device are required. The evaluator never starts adb or an emulator."
    );
  }
  const adb = (...args) => {
    try {
      return execFileSync(
        "adb",
        ["-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args],
        { encoding: "utf-8", timeout: 15_000 }
      ).trim();
    } catch {
      throw new Error(
        `Android prerequisite: the selected attached device did not answer ${args[0]}. Check its authorization and installed checkout fixture. No device is booted.`
      );
    }
  };
  assert.equal(
    adb("get-state"),
    "device",
    "Android prerequisite: selected device is not attached and authorized"
  );
  const appId = "dev.contingency.checkout";
  assert.ok(
    adb("shell", "pm", "path", appId).startsWith("package:"),
    "Android prerequisite: install the working checkout fixture with submitted-shopper readback before evaluation"
  );
  const appBuild = adb("shell", "dumpsys", "package", appId).match(
    /versionCode=(?<build>\d+)/u
  )?.groups.build;
  assert.ok(
    appBuild,
    "Android prerequisite: installed fixture build cannot be read"
  );
  const emulator = serial.startsWith("emulator-");
  const device = {
    api: Number(adb("shell", "getprop", "ro.build.version.sdk")),
    fingerprint: adb("shell", "getprop", "ro.build.fingerprint"),
    host: "local",
    serial,
  };
  if (emulator) {
    device.avd = adb("emu", "avd", "name").split("\n")[0].trim();
  } else {
    device.kind = "physical";
    device.model = adb("shell", "getprop", "ro.product.model");
  }
  return {
    appId,
    authorization: "explicit operator selection; restart fixture only",
    installs: false,
    selection: {
      device,
      environment: {
        androidVersion: adb("shell", "getprop", "ro.build.version.release"),
        appBuild,
        appId,
        startingState: "group Fixture Shop sign in is visible",
      },
      helperConsent: "none",
      outcomes: [{ name: "Order confirmed", role: "group" }],
      setup: {
        activity: `${appId}/.MainActivity`,
        conditions: [{ name: "Fixture Shop sign in", role: "group" }],
        kind: "restart-activity",
      },
    },
    serial,
  };
};
export const prepareAndroid = async (options, device) => {
  // Same disposable verified-package convention as the browser checkout seed.
  const requirements = {
    capabilities: ["semantic-actions", "screenshots"],
    environment: device.selection.environment,
    outcomes: device.selection.outcomes,
    platform: "android",
    preparation: device.selection.setup,
    reversibleActions: [
      { name: "Sign in", role: "button" },
      { name: "Add Anvil to cart", role: "button" },
      { name: "Open cart", role: "button" },
      { name: "Place mock order", role: "button" },
    ],
  };
  const skill = path.join(
    options.mcp.directory,
    "catalog/eval-android-checkout"
  );
  await mkdir(path.join(skill, "references"), { recursive: true });
  const content = `---
name: eval-android-checkout
description: Submit one mock Anvil order in the disposable Android fixture.
inputs:
runtime: ${JSON.stringify(requirements)}
---

1. Enter the requested public Shopper name and activate Sign in.
   Done when: Catalog is visible.
2. Activate Add Anvil to cart, then Open cart.
   Done when: The cart holds one Anvil.
3. Activate Place mock order.
   Done when: Order confirmed and the submitted shopper are visible.
`;
  await writeFile(path.join(skill, "SKILL.md"), content);
  await writeFile(
    path.join(skill, "references/verification.md"),
    "- Verified: 2026-10-01T00:00:00.000Z\n- Platform: android\n"
  );
  json(path.join(options.directory, "seed.json"), {
    method: "task-proof disposable verified package",
    requirements,
    skill: content,
  });
  const ui = await workspace(options);
  const session = await options.mcp.operation("agent_android_workspace", {
    command: {
      _tag: "start",
      flowSkillName: "eval-android-checkout",
      kind: "run",
      operationId: "eval-android-start",
      recordingId: null,
      selection: device.selection,
    },
  });
  await ui.open(`http://127.0.0.1:${options.mcp.port}/?android=${session.id}`);
  assert.deepEqual(session.preparation.differences, []);
  assert.deepEqual(session.preparation.pending, []);
  await ui.click(
    device.selection.device.avd
      ? "Prepare selected emulator"
      : "Prepare selected device"
  );
  await ui.command("wait", { name: "Take control", role: "button" });
  const observed = await options.mcp.operation("agent_android_workspace", {
    command: { _tag: "observe", image: false, sessionId: session.id },
  });
  assert.ok(
    observed.observation.nodes.some(
      (node) => node.name === "Fixture Shop sign in"
    ),
    "Android seed must start at a clean sign-in screen"
  );
  await ui.capture("android-prepared");
  return { androidSessionId: session.id };
};
export const checkAndroid = async (device, finalText, resources) => {
  const child = resources.start("adb", [
    "-H",
    "127.0.0.1",
    "-P",
    "5037",
    "-s",
    device.serial,
    "exec-out",
    "uiautomator",
    "dump",
    "/dev/tty",
  ]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const guard = setTimeout(() => child.kill("SIGTERM"), 30_000);
  let exit;
  try {
    [exit] = await once(child, "close");
  } finally {
    clearTimeout(guard);
  }
  const confirmed =
    output.includes("Order confirmed") &&
    output.includes("Shopper: Eval Shopper") &&
    output.includes("Mock order for Anvil.");
  return {
    complete:
      exit === 0 &&
      confirmed &&
      /Order confirmed/iu.test(finalText) &&
      /Eval Shopper/u.test(finalText),
    exit,
    extraEffects: [],
    source: "selected device UI hierarchy",
    submitted: { confirmed, shopper: output.includes("Shopper: Eval Shopper") },
  };
};
