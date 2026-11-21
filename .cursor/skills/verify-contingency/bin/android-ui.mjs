/* oxlint-disable eslint/no-await-in-loop -- UI gestures run in order. */
import assert from "node:assert/strict";

/**
 * Wait on the UI command completion, including forwarded stream input. The
 * live device stage is `aria-busy` while a dock command runs; an ended
 * session's last frame has no busy state, so it never reads as idle.
 */
export const waitAndroidIdle = async (page) => {
  await page
    .getByRole("region", { exact: true, name: "Session status" })
    .waitFor();
  await page.waitForFunction(
    () => {
      const stage = document.querySelector(
        'section[aria-label="Android device"][aria-busy]'
      );
      return Boolean(
        stage?.getAttribute("aria-busy") === "false" &&
        !document.querySelector('[aria-busy="true"]')
      );
    },
    undefined,
    { timeout: 90_000 }
  );
};

/**
 * Closes the shown Android or iOS session as a user does. **Close session**
 * sits in the `Agent Session` picker, beside the shown live session, not in
 * the Session status island. Once the session closes, the island offers
 * **New session** after Teaching, or **Done** after a Dry Run or Run.
 */
export const closeNativeSession = async (page) => {
  await page
    .getByRole("combobox", { exact: true, name: "Agent Session" })
    .click();
  await page
    .getByRole("dialog", { exact: true, name: "Agent Sessions" })
    .getByRole("button", { exact: true, name: "Close session" })
    .click();
  const island = page.getByRole("region", {
    exact: true,
    name: "Session status",
  });
  await island
    .getByRole("button", { exact: true, name: "New session" })
    .or(island.getByRole("button", { exact: true, name: "Done" }))
    .first()
    .waitFor({ timeout: 90_000 });
  return { closed: true };
};

const escapeRegExp = (text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

/**
 * Picks an installed Target App on the Android or iOS start card. The
 * `Target App` combobox waits, disabled, until the device's apps are read;
 * typing searches by name or ID, and each app is an `option` named
 * `<Label> <id> · build <n>`. Reading a freshly booted device's apps is slow,
 * and an app that updates mid-listing fails the whole listing (a pre-existing
 * discovery race), so a failed listing is refreshed, never preparation.
 */
export const chooseTargetApp = async (page, appId, timeout = 300_000) => {
  const field = page.getByRole("combobox", {
    exact: true,
    name: "Target App",
  });
  const failed = page.getByText(
    /Could not read APK metadata|discovery failed/u
  );
  const deadline = Date.now() + timeout;
  let refreshes = 0;
  while (!(await field.isEnabled({ timeout: 30_000 }))) {
    assert.ok(Date.now() < deadline, "The Target App field never listed apps.");
    if ((await failed.count()) > 0) {
      refreshes += 1;
      assert.ok(refreshes <= 5, "The installed-app listing kept failing.");
      await page
        .getByRole("button", { exact: true, name: "Refresh devices" })
        .click();
    }
    await page.waitForTimeout(1000);
  }
  await field.click();
  await field.fill(appId);
  await page
    .getByRole("option", {
      name: new RegExp(`${escapeRegExp(appId)} · build `, "u"),
    })
    .click({ timeout: 30_000 });
  return { appId, refreshes };
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

/**
 * Shared accessible setup recipe on the home's Teach on Android start card;
 * all choices are discovered UI entries.
 */
export const openAndroidStartCard = async (
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
  await click("Start an Android session");
  await control(
    "browser",
    "wait",
    "--role",
    "form",
    "--name",
    "Teach on Android"
  );
  await fill("Flow name", flowName);
  // Each device is an option of the Device field: `Pixel_9 · Android 16
  // emulator-5554`, its name, OS version and serial.
  await control("browser", "click", "--role", "combobox", "--name", "Device");
  await control(
    "browser",
    "click",
    "--role",
    "option",
    "--name",
    selection.device.serial,
    "--partial"
  );
  // The Target App combobox lists the device's apps once they are read.
  await control("browser", "target-app", "--app", selection.environment.appId);
  // Starting data, permissions, Variables and conditions sit in Setup. The
  // In progress shelf can list a session named like `setup-sign-in`, so
  // Setup is named with its hint.
  await click("Setup Starting data", true);
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
    await control(
      "browser",
      "click",
      "--role",
      "radio",
      "--name",
      `${label}: ${entry.decision === "grant" ? "Grant before start" : "Deny before start"}`
    );
  }
  await snapshot("start-card");
  await click("Start teaching");
  await snapshot("setup-confirmation");
  await click("Confirm preparation");
  await control(
    "browser",
    "wait",
    "--role",
    "region",
    "--name",
    "Session status",
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
/**
 * Records a comment through the native composer, on Android or iOS. With
 * `attach`, it first attaches that element through Attach element and
 * Screen elements, the keyboard path of the picker (ADR 0088).
 */
export const nativeComment = async (control, text, attach) => {
  const click = (name) =>
    control("browser", "click", "--role", "button", "--name", name);
  await click("Comment");
  if (attach !== undefined) {
    await click("Attach element");
    await control(
      "browser",
      "fill",
      "--role",
      "textbox",
      "--name",
      "Filter screen elements",
      "--value",
      attach
    );
    await click(`Attach ${attach}`);
    await control("browser", "wait", "--text", "Change element");
  }
  await control(
    "browser",
    "fill",
    "--role",
    "textbox",
    "--name",
    "Comment",
    "--value",
    text
  );
  await click("Add comment");
};
export const androidComment = async (control, text, attach) => {
  await nativeComment(control, text, attach);
  await androidIdle(control);
};

/**
 * Turns the wheel on the live device display and reports how the picture
 * follows: when it first changed after each gesture began, when the content
 * stopped after the last wheel event (`settledMs`), and every later change. Trailing change is the backlog a
 * wheel builds when the device scrolls slower than the wheel turns. Draws are
 * sampled once per animation frame from a small copy of the canvas, so these
 * are canvas times, not screen paint times; an animating app keeps drawing.
 */
export const scrollCheckDevice = async (page, flags) => {
  const events = Math.min(Math.max(Number(flags.events ?? 40), 2), 240);
  const delta = Math.min(Math.max(Number(flags.delta ?? 80), 1), 1000);
  const gapMs = Math.min(Math.max(Number(flags["gap-ms"] ?? 16), 4), 200);
  const fy = Number(flags.fy ?? 0.6);
  const canvas = page.locator('canvas[aria-roledescription="device display"]');
  await canvas.waitFor({ timeout: 30_000 });
  const box = await canvas.boundingBox();
  assert.ok(box, "The live device display has no box.");
  await page.evaluate(() => {
    const target = document.querySelector(
      'canvas[aria-roledescription="device display"]'
    );
    const sample = document.createElement("canvas");
    sample.width = 24;
    sample.height = 48;
    const context = sample.getContext("2d", { willReadFrequently: true });
    const probe = { changes: [], running: true, wheels: [] };
    let previous;
    const tick = () => {
      if (!probe.running) {
        return;
      }
      context.drawImage(target, 0, 0, 24, 48);
      const { data } = context.getImageData(0, 0, 24, 48);
      if (previous !== undefined) {
        let change = 0;
        for (let index = 0; index < data.length; index += 1) {
          change += Math.abs(data[index] - previous[index]);
        }
        if (change / data.length >= 2) {
          probe.changes.push(performance.now());
        }
      }
      previous = data;
      requestAnimationFrame(tick);
    };
    target.addEventListener(
      "wheel",
      () => probe.wheels.push(performance.now()),
      { capture: true, passive: true }
    );
    globalThis.__contingencyScrollProbe = probe;
    requestAnimationFrame(tick);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * fy);
  const gestures = [];
  const opening = flags.start === "up" ? -1 : 1;
  for (const direction of [opening, -opening, opening]) {
    const startedAt = await page.evaluate(() => performance.now());
    for (let index = 0; index < events; index += 1) {
      await page.mouse.wheel(0, direction * delta);
      await page.waitForTimeout(gapMs);
    }
    // Quiet for 1.5 s, or 8 s at most, ends the gesture.
    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      (await page.evaluate(
        ({ startedAt: start }) => {
          const probe = globalThis.__contingencyScrollProbe;
          const last = Math.max(
            probe.changes.at(-1) ?? start,
            probe.wheels.at(-1) ?? start
          );
          return performance.now() - last <= 1500;
        },
        { startedAt }
      ))
    ) {
      await page.waitForTimeout(50);
    }
    const result = await page.evaluate(
      ({ startedAt: start }) => {
        const probe = globalThis.__contingencyScrollProbe;
        const wheels = probe.wheels.filter((at) => at >= start);
        const changes = probe.changes.filter((at) => at >= start);
        const [first] = wheels;
        const last = wheels.at(-1);
        const responded = changes.find((at) => at >= first);
        const settled = changes.at(-1);
        // When the picture changed after the last wheel event, in ms.
        const trailingChangesMs = changes
          .filter((at) => at > last)
          .map((at) => Math.round(at - last));
        // When the content stopped: the end of the run of changes that
        // follows the last wheel event without a 200 ms pause. A scroll
        // indicator fading later does not count.
        let settledMs = 0;
        for (const offset of trailingChangesMs) {
          if (offset - settledMs > 200) {
            break;
          }
          settledMs = offset;
        }
        return {
          changedFrames: changes.length,
          firstResponseMs:
            responded === undefined ? null : Math.round(responded - first),
          settledMs,
          trailingChangesMs,
          trailingMs:
            settled === undefined || settled < last
              ? 0
              : Math.round(settled - last),
          wheelEvents: wheels.length,
          wheelSpanMs: Math.round(last - first),
        };
      },
      { startedAt }
    );
    gestures.push({ direction: direction > 0 ? "down" : "up", ...result });
  }
  await page.evaluate(() => {
    globalThis.__contingencyScrollProbe.running = false;
  });
  return { delta, events, gapMs, gestures };
};
