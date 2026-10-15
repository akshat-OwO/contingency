/* oxlint-disable eslint/no-await-in-loop -- UI gestures run in order. */
import assert from "node:assert/strict";

/** Wait on the UI command completion, including the separate stream-pick gesture. */
export const waitAndroidIdle = async (page) => {
  await page
    .getByRole("region", { exact: true, name: "Workspace dock" })
    .waitFor();
  await page.waitForFunction(
    () => {
      const dock = document.querySelector('[aria-label="Workspace dock"]');
      const close = [...(dock?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Close session"
      );
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

/** Resolve a semantic name only to aim the real mouse; the UI performs the pick. */
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
  const canvas = page.getByRole("img", {
    exact: true,
    name: "Selected device live display",
  });
  await canvas.waitFor();
  await page.waitForFunction(() => {
    const display = document.querySelector(
      'canvas[aria-label="Selected device live display"]'
    );
    return (
      display && display.width > 0 && !display.classList.contains("invisible")
    );
  });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  // Every pick takes a fresh observation, so the session revision advances
  // whether the server activates, selects a field, or refuses. Picks travel
  // over the RPC WebSocket, so there is no HTTP response to wait on.
  const initial = await call({ _tag: "read", sessionId });
  const before = initial.revision;
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { revision } = await call({ _tag: "read", sessionId });
    if (revision > before) {
      break;
    }
    assert.ok(Date.now() < deadline, "The pick did not reach the session.");
    await page.waitForTimeout(250);
  }
  await waitAndroidIdle(page);
  return { fx, fy, sessionId };
};

/** Shared accessible setup recipe; all choices are discovered UI entries. */
export const openAndroidSheet = async (
  control,
  selection,
  flowSkillName,
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
  const select = (name, value) =>
    control(
      "browser",
      "select",
      "--role",
      "combobox",
      "--name",
      name,
      "--value",
      value
    );
  await click("Android");
  await click("Open Android session");
  await fill("Flow skill name", flowSkillName);
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
  await select(
    "Starting screen element role",
    selection.setup.conditions[0].role
  );
  await fill("Starting screen element", selection.setup.conditions[0].name);
  await select("Done when element role", selection.outcomes[0].role);
  await fill("Done when element", selection.outcomes[0].name);
  await select(
    "Contingency's pinned helper",
    process.env.CONTINGENCY_ANDROID_HELPER_CONSENT ?? "none"
  );
  if (selection.privateInput) {
    await control(
      "browser",
      "click",
      "--role",
      "checkbox",
      "--name",
      "Enable private Variables"
    );
    await select(
      "Private text helper",
      selection.privateHelperConsent ?? "none"
    );
  }
  const permissions = selection.environment.permissions ?? [];
  const notification = permissions.find(
    (entry) => entry.permission === "android.permission.POST_NOTIFICATIONS"
  );
  await select(
    "Notification permission",
    notification?.decision ?? "unchanged"
  );
  await fill(
    "Additional permission decisions",
    permissions
      .filter(
        (entry) => entry.permission !== "android.permission.POST_NOTIFICATIONS"
      )
      .map((entry) => `${entry.decision} ${entry.permission}`)
      .join("\n")
  );
  await snapshot("setup-sheet");
  await click("Open session");
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
