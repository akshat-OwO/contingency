/* oxlint-disable eslint/no-await-in-loop -- UI gestures run in order. */
import assert from "node:assert/strict";

/** Wait on the UI command completion, including forwarded stream input. */
export const waitAndroidIdle = async (page) => {
  await page
    .getByRole("region", { exact: true, name: "Workspace dock" })
    .waitFor();
  await page.waitForFunction(
    () => {
      const dock = document.querySelector('[aria-label="Workspace dock"]');
      // Match the accessible name: the visible label is "Close" on a narrow
      // dock and "Close session" on a wider one.
      const close = dock?.querySelector('button[aria-label="Close session"]');
      return Boolean(
        close &&
        !close.disabled &&
        !document.querySelector('[aria-busy="true"]')
      );
    },
    undefined,
    { timeout: 90_000 }
  );
};

/** Resolve a semantic name only to aim the real mouse; the click goes to the device. */
export const pickAndroid = async (page, flags, call) => {
  const sessionId = flags["session-id"];
  assert.match(
    sessionId,
    /^agent-[\w-]+$/u,
    "android-pick needs --session-id."
  );
  assert.equal(
    new URL(page.url()).searchParams.get("android"),
    sessionId,
    "Open the selected Android session URL before picking."
  );
  await waitAndroidIdle(page);
  const session = await call({ _tag: "observe", image: false, sessionId });
  let fx;
  let fy;
  if (flags.fx !== undefined || flags.fy !== undefined) {
    assert.equal(
      flags.role,
      undefined,
      "Use a semantic target or raw fractions, not both."
    );
    assert.equal(
      flags.name,
      undefined,
      "Use a semantic target or raw fractions, not both."
    );
    fx = Number(flags.fx);
    fy = Number(flags.fy);
  } else {
    assert.match(flags.role, /^[a-z][a-z-]*$/u, "android-pick needs --role.");
    assert.match(flags.name, /^[\s\S]*$/u, "android-pick needs --name.");
    const { observation } = session;
    const matches =
      observation?.nodes.filter(
        (node) =>
          node.role === flags.role &&
          node.name === flags.name &&
          !node.covered &&
          node.bounds
      ) ?? [];
    assert.equal(
      matches.length,
      1,
      "Pick requires one visible bounded semantic target."
    );
    const { x, y, width, height } = matches[0].bounds;
    assert.ok(
      width > 0 && height > 0 && observation.width > 0 && observation.height > 0
    );
    fx = (x + width / 2) / observation.width;
    fy = (y + height / 2) / observation.height;
  }
  assert.ok(Number.isFinite(fx) && fx >= 0 && fx < 1, "--fx must be in [0,1).");
  assert.ok(Number.isFinite(fy) && fy >= 0 && fy < 1, "--fy must be in [0,1).");
  // The display is an image while the agent holds the device and an
  // application, with a longer name, while the user does.
  const canvas = page.locator(
    'canvas[aria-label^="Selected device live display"]'
  );
  await canvas.waitFor();
  await page.waitForFunction(() => {
    const display = document.querySelector(
      'canvas[aria-label^="Selected device live display"]'
    );
    return (
      display && display.width > 0 && !display.classList.contains("invisible")
    );
  });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  // The click is Forwarded Input: it reaches the device at once, and the
  // observation that settles after it advances the session revision.
  // Input travels over the RPC WebSocket, so there is no HTTP response.
  const initial = await call({ _tag: "read", sessionId });
  const before = initial.revision;
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { revision } = await call({ _tag: "read", sessionId });
    if (revision > before) {
      break;
    }
    assert.ok(Date.now() < deadline, "No observation settled after the click.");
    await page.waitForTimeout(250);
  }
  await waitAndroidIdle(page);
  return { fx, fy, sessionId };
};

const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');

/**
 * Types into the focused device field the way a person does on the live
 * display: it focuses the display, holds Shift for capitals and symbols,
 * and presses each key. The keys are Forwarded Input; nothing goes through
 * the dock.
 */
export const typeOnDevice = async (page, text) => {
  const display = page.locator(
    'canvas[aria-label^="Selected device live display"], canvas[aria-label^="Live iOS viewport"]'
  );
  await display.first().focus();
  for (const character of text) {
    const shifted =
      SHIFTED.has(character) ||
      (character !== character.toLowerCase() &&
        character === character.toUpperCase());
    if (shifted) {
      await page.keyboard.down("Shift");
    }
    await page.keyboard.press(character === " " ? "Space" : character);
    if (shifted) {
      await page.keyboard.up("Shift");
    }
  }
  return { typed: text.length };
};

/** Shared accessible setup recipe; all choices are discovered UI entries. */
export const openAndroidSheet = async (
  control,
  selection,
  flowName,
  snapshot
) => {
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
  const select = async (name, value) => {
    await control("browser", "click", "--role", "combobox", "--name", name);
    await control("browser", "click", "--role", "option", "--name", value);
  };
  await click("Android");
  await click("Open Android session");
  await fill("Flow name", flowName);
  await click(selection.device.serial, true);
  await fill("Search installed apps", selection.environment.appId);
  // Reading installed apps pulls each APK's label; a freshly booted device is slow.
  await control(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    selection.environment.appId,
    "--partial",
    "--timeout-ms",
    "180000"
  );
  await click(selection.environment.appId, true);
  await click("Optional steps");
  await select(
    "Starting screen element role",
    selection.setup.conditions[0].role
  );
  await fill("Starting screen element", selection.setup.conditions[0].name);
  await select("Done when element role", selection.outcomes[0].role);
  await fill("Done when element", selection.outcomes[0].name);
  if (selection.privateInput) {
    await control(
      "browser",
      "click",
      "--role",
      "checkbox",
      "--name",
      "Enable Variables"
    );
  }
  const labels = {
    ACCESS_COARSE_LOCATION: "Approximate location",
    ACCESS_FINE_LOCATION: "Precise location",
    BLUETOOTH_CONNECT: "Nearby devices",
    CAMERA: "Camera",
    POST_NOTIFICATIONS: "Notifications",
    READ_CALENDAR: "Calendar",
    READ_CONTACTS: "Contacts",
    READ_MEDIA_IMAGES: "Photos",
    READ_MEDIA_VIDEO: "Videos",
    RECORD_AUDIO: "Microphone",
  };
  for (const entry of selection.environment.permissions ?? []) {
    const label = labels[entry.permission.replace("android.permission.", "")];
    if (!label) {
      throw new Error(`No setup control for ${entry.permission}`);
    }
    await select(
      `${label} permission`,
      entry.decision === "grant" ? "Grant before start" : "Deny before start"
    );
  }
  await snapshot("setup-sheet");
  await click("Prepare and open app");
  await snapshot("setup-confirmation");
  await click("Confirm preparation");
  await control(
    "browser",
    "wait",
    "--role",
    "region",
    "--name",
    "Workspace dock",
    "--timeout-ms",
    "90000"
  );
  await control("browser", "android-idle");
};

export const androidPick = (control, sessionId, role, name) =>
  control(
    "browser",
    "android-pick",
    "--session-id",
    sessionId,
    "--role",
    role,
    "--name",
    name
  );
export const androidIdle = (control) => control("browser", "android-idle");
export const deviceType = (control, text) =>
  control("browser", "device-type", "--text", text);
export const androidComment = async (control, text) => {
  await control("browser", "click", "--role", "button", "--name", "Comment");
  await control(
    "browser",
    "fill",
    "--role",
    "textbox",
    "--name",
    "Instruction",
    "--value",
    text
  );
  await control("browser", "click", "--role", "button", "--name", "Add");
  await androidIdle(control);
};
