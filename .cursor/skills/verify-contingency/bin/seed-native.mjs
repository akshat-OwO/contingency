// Native (Android and iOS) states for `control-contingency seed` (#785).
//
// A device holds one session at a time, so each platform's states form one
// chain on one device. `seed --android` (or `--ios`) teaches and saves a Flow
// on the device through the start card, then opens a second Teaching session
// and leaves it ready. `seed capture` walks the rest of the chain in order:
// it records in that session, closes it, starts the saved Flow's Dry Run as
// the agent, takes control, and ends the Dry Run. Those later entries are
// consumed by one capture; the next `seed` starts the chain again.
/* oxlint-disable no-await-in-loop -- Device gestures run in order. */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { nativeComment } from "./android-ui.mjs";

const execute = promisify(execFile);
const LIVE = new Set(["pending", "running", "paused"]);

const PLATFORMS = {
  android: {
    app: "dev.contingency.checkout",
    attach: "Catalog",
    deviceEnv: "CONTINGENCY_SEED_ANDROID_SERIAL",
    done: { name: "Catalog", role: "group" },
    field: { name: "Shopper name", role: "text-field" },
    flag: "--android",
    label: "Android",
    pin: "Sign in",
    prepare: "Prepare selected emulator",
    query: "android",
    start: { name: "Fixture Shop sign in", role: "group" },
    submit: { name: "Sign in", role: "button" },
  },
  ios: {
    app: "dev.contingency.ioslogin",
    attach: "Sign in privately",
    deviceEnv: "CONTINGENCY_SEED_IOS_UDID",
    // The login screen stays up while the public name is typed.
    done: { name: "Login fixture", role: "text" },
    field: { name: "Login name", role: "text-field" },
    flag: "--ios",
    label: "iOS",
    pin: "Sign in privately",
    prepare: "Prepare selected simulator",
    query: "ios",
    start: { name: "Login fixture", role: "text" },
    submit: undefined,
  },
};

const publicName = "Seed shopper";

/** The one Android emulator `adb` lists, or the one the env var names. */
const androidDevice = async () => {
  const named = process.env.CONTINGENCY_SEED_ANDROID_SERIAL?.trim();
  if (named) {
    return { serial: named };
  }
  const home =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(os.homedir(), "Library/Android/sdk");
  const { stdout } = await execute(path.join(home, "platform-tools/adb"), [
    "devices",
  ]);
  const running = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(
      ([serial, state]) => serial?.startsWith("emulator-") && state === "device"
    )
    .map(([serial]) => serial);
  if (running.length !== 1) {
    throw new Error(
      `seed --android needs exactly one running emulator (found ${running.length}); set CONTINGENCY_SEED_ANDROID_SERIAL.`
    );
  }
  return { serial: running[0] };
};

/** The one booted iOS simulator, or the one the env var names. */
const iosDevice = async () => {
  const { stdout } = await execute("xcrun", [
    "simctl",
    "list",
    "devices",
    "-j",
  ]);
  const devices = Object.values(JSON.parse(stdout).devices).flat();
  const named = process.env.CONTINGENCY_SEED_IOS_UDID?.trim();
  const booted = named
    ? devices.filter((device) => device.udid === named)
    : devices.filter((device) => device.state === "Booted");
  if (booted.length !== 1 || booted[0].state !== "Booted") {
    throw new Error(
      named
        ? `Simulator ${named} is not booted.`
        : `seed --ios needs exactly one booted simulator (found ${booted.length}); set CONTINGENCY_SEED_IOS_UDID.`
    );
  }
  return { name: booted[0].name, udid: booted[0].udid };
};

const prototypeStart = (key) => ({
  actions: [{ press: key }],
  path: "/",
});
// The prototype's Start teaching waits for a Target App: an installed
// Android app, or an uploaded build on iOS.
const prototypeApp = {
  2: [
    { click: ["combobox", "Target App"] },
    { click: ["option", "Shop", { partial: true }] },
  ],
  3: [{ upload: ["button", "Upload a build browse"] }],
};
const prototypeTeaching = (key, more = []) => ({
  actions: [
    { press: key },
    ...prototypeApp[key],
    { click: ["button", "Start teaching"] },
    { wait: ["button", "Start recording"] },
    ...more,
  ],
  path: "/",
});

/**
 * A reopened stage connects its stream before it draws the screen; shoot
 * the screen, not the loader. The display is an `application` while the
 * user holds the device and an `img` while the agent does.
 */
const streamed = (platform, holder) => ({
  wait: [
    holder === "agent" ? "img" : "application",
    platform === "android"
      ? "Selected device live display"
      : "Live iOS viewport",
    { partial: true, "timeout-ms": 90_000 },
  ],
});

export const nativeSeeding = (kit) => {
  const { browser, call, click, goto, operation, run, waitFor } = kit;
  const control = (...args) => run(args);
  const device = (platform, command) =>
    call("agent_device_workspace", { command, platform });
  const read = (platform, sessionId) =>
    device(platform, { _tag: "read", sessionId });
  const observe = (platform, sessionId) =>
    device(platform, { _tag: "observe", image: false, sessionId });
  const viewUrl = (platform, sessionId) =>
    `${kit.mcpPage("/")}?${PLATFORMS[platform].query}=${sessionId}`;
  const devices = { android: androidDevice, ios: iosDevice };
  const resolved = new Map();
  const deviceOf = (platform) => {
    if (!resolved.has(platform)) {
      resolved.set(platform, devices[platform]());
    }
    return resolved.get(platform);
  };
  /** Whether a handle shows within `timeoutMs`, without failing. */
  const shows = async (role, name, timeoutMs = 2000, extra = {}) => {
    try {
      await waitFor(role, name, { ...extra, "timeout-ms": timeoutMs });
      return true;
    } catch {
      return false;
    }
  };
  const until = async (platform, sessionId, accept, what) => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const session = await read(platform, sessionId);
      if (accept(session)) {
        return session;
      }
      if (Date.now() > deadline) {
        throw new Error(`${sessionId} never ${what}: ${session.phase}`);
      }
      await sleep(500);
    }
  };
  /** The live session the start card opened, once the host lists it. */
  const findSession = async (platform, flowName) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const listed = await call("agent_device_sessions_list", { platform });
      const found = listed.find(
        (session) => session.flowName === flowName && LIVE.has(session.phase)
      );
      if (found) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`No live ${platform} session for ${flowName}`);
      }
      await sleep(500);
    }
  };

  /** The user picks an element on the live display; the tap is Forwarded Input. */
  const pick = (platform, sessionId, { name, role }) =>
    browser(`${platform}-pick`, { name, role, "session-id": sessionId });

  // The start card, as the user fills it --------------------------------
  /**
   * Opens Setup and declares the starting and finishing elements. The
   * session shelf can list a session named like `setup-sign-in`, so Setup is
   * named with its hint.
   */
  const fillSetup = async (platform) => {
    const { done, start } = PLATFORMS[platform];
    await click("button", "Setup Starting data", { partial: true });
    for (const [label, element] of [
      ["Starting screen element", start],
      ["Done when element", done],
    ]) {
      if (platform === "android") {
        await click("combobox", `${label} role`);
        await click("option", element.role);
      }
      await browser("fill", {
        name: label,
        role: "textbox",
        value: element.name,
      });
    }
  };
  /** Picks the Target App once the installed apps list it. */
  const chooseApp = async (platform) => {
    const { app } = PLATFORMS[platform];
    const deadline = Date.now() + 300_000;
    // Reading a freshly booted device's apps is slow, and an app that
    // updates mid-listing fails the listing; refresh it, never preparation.
    while (!(await shows("button", app, 5000, { partial: true }))) {
      if (Date.now() > deadline) {
        throw new Error(`${app} never showed in Installed apps.`);
      }
      if (
        platform === "android" &&
        (await shows("text", "Could not read APK metadata", 500, {
          partial: true,
        }))
      ) {
        await click("button", "Refresh devices");
      }
    }
    await click("button", app, { partial: true });
  };
  const startAndroid = async (flowName) => {
    const { serial } = await deviceOf("android");
    const { app } = PLATFORMS.android;
    await goto(kit.mcpPage("/?android=new"));
    await waitFor("form", "Teach on Android", { "timeout-ms": 60_000 });
    await browser("fill", {
      name: "Flow name",
      role: "textbox",
      value: flowName,
    });
    await click("combobox", "Device");
    await click("option", serial, { partial: true });
    await browser("fill", {
      name: "Search installed apps",
      role: "textbox",
      value: app,
    });
    await chooseApp("android");
    await fillSetup("android");
    await click("button", "Start teaching");
    await click("button", "Confirm preparation");
    await waitFor("region", "Session status", { "timeout-ms": 90_000 });
    await browser("android-idle");
    return findSession("android", flowName);
  };
  const startIos = async (flowName) => {
    const { name } = await deviceOf("ios");
    const { prepare } = PLATFORMS.ios;
    await goto(kit.mcpPage("/?ios=new"));
    await waitFor("form", "Teach on iOS", { "timeout-ms": 60_000 });
    await browser("fill", {
      name: "Flow name",
      role: "textbox",
      value: flowName,
    });
    await click("combobox", "Simulator");
    await click("option", `${name} iOS`, { partial: true });
    await chooseApp("ios");
    await fillSetup("ios");
    await click("button", "Start teaching");
    const session = await findSession("ios", flowName);
    await goto(viewUrl("ios", session.id));
    await waitFor("button", prepare, { "timeout-ms": 120_000 });
    await click("button", prepare);
    await waitFor("button", "Start recording", { "timeout-ms": 180_000 });
    return session;
  };
  const startTeaching = (platform, flowName) =>
    platform === "android" ? startAndroid(flowName) : startIos(flowName);

  /**
   * One comment on a control that stays on the screen, so the card lists it
   * and the screen pins it. It is added while the screen is still, before
   * typing opens the keyboard and moves the observation on.
   */
  const pinComment = async (platform, sessionId) => {
    const { pin } = PLATFORMS[platform];
    await nativeComment(control, `${pin} sends the public name.`, pin);
    // A saved comment closes the card; a refused one keeps it with an alert.
    await waitFor("dialog", "Comment", { state: "hidden" });
    await until(
      platform,
      sessionId,
      (session) => (session.instructions?.length ?? 0) > 0,
      "listed the comment"
    );
    if (platform === "android") {
      await browser("android-idle");
    }
  };

  /**
   * Start recording and type the public name into the field. A session
   * already recording has typed it; the field is then named by its text.
   */
  const recordJourney = async (platform, sessionId, { pin = false } = {}) => {
    const { field } = PLATFORMS[platform];
    if (await shows("button", "Stop recording")) {
      return;
    }
    await click("button", "Start recording");
    await waitFor("button", "Stop recording", { "timeout-ms": 60_000 });
    if (pin) {
      await pinComment(platform, sessionId);
    }
    await pick(platform, sessionId, field);
    const { revision } = await read(platform, sessionId);
    await browser("device-type", { text: publicName });
    // Android reads the typed text back as the field's name. iOS reports no
    // field value, so the observation that settles after typing stands in.
    const shown = (session) =>
      platform === "ios"
        ? session.revision > revision
        : session.observation?.nodes.some((node) =>
            node.name.toLowerCase().includes(publicName.toLowerCase())
          );
    await until(platform, sessionId, shown, "showed the typed name");
    if (platform === "android") {
      await browser("android-idle");
    }
  };

  /** Stop recording and close the session from its dock, as the user does. */
  const stopAndClose = async (platform, sessionId) => {
    if (await shows("button", "Stop recording")) {
      await click("button", "Stop recording");
      await until(
        platform,
        sessionId,
        (session) => session.captureState?._tag !== "recording",
        "stopped recording"
      );
    }
    await click("button", "Close session");
    await until(
      platform,
      sessionId,
      (session) => !LIVE.has(session.phase),
      "closed"
    );
  };

  /** Teach, stop, claim and save a Flow, as a user and a learning agent do. */
  const learn = async (platform, flowName) => {
    const { attach, submit } = PLATFORMS[platform];
    const teaching = await startTeaching(platform, flowName);
    await goto(viewUrl(platform, teaching.id));
    await recordJourney(platform, teaching.id);
    if (submit) {
      await pick(platform, teaching.id, submit);
    }
    await nativeComment(
      control,
      `${attach} shows the journey reached its end.`,
      attach
    );
    const { recordingId, selection } = await read(platform, teaching.id);
    await stopAndClose(platform, teaching.id);
    const claimOperationId = operation("claim");
    await call("agent_teaching_recording_claim", {
      action: "take",
      claimOperationId: null,
      error: null,
      operationId: claimOperationId,
      recordingId,
    });
    await call("agent_teaching_timeline_get", {
      claimOperationId,
      cursor: 0,
      recordingId,
    });
    const steps = [
      `1. Enter ${publicName} in ${PLATFORMS[platform].field.name}. Done when: ${publicName} is visible.`,
      submit
        ? `2. Activate ${submit.name}. Done when: ${PLATFORMS[platform].done.name} is visible.`
        : undefined,
    ].filter(Boolean);
    await call("agent_flow_save", {
      claimOperationId,
      files: [
        {
          content: `---\nname: ${flowName}\ndescription: Enter a public name in the ${PLATFORMS[platform].label} fixture. Use when seeding Workspace states.\ninputs:\n---\n\n# Enter a public name\n\n${steps.join("\n")}\n`,
          path: "flow.md",
        },
      ],
      operationId: operation("save"),
      recordingId,
    });
    return { flowName, recordingId, selection };
  };

  /** Close this seed's sessions still holding the device, from their docks. */
  const releaseDevice = async (platform) => {
    const listed = await call("agent_device_sessions_list", { platform });
    for (const session of listed.filter(
      (entry) => entry.flowName.startsWith("seed-") && LIVE.has(entry.phase)
    )) {
      // The user holds a Teaching session, so the user closes it.
      await goto(viewUrl(platform, session.id));
      await waitFor("button", "Close session", { "timeout-ms": 60_000 });
      await stopAndClose(platform, session.id);
    }
  };

  // Capture-time steps ------------------------------------------------------
  // Each takes the entry and its platform's chain, which `seed capture`
  // keeps in the manifest so later entries can name the Dry Run it starts.
  const steps = {
    complete: async ({ chain, platform }) => {
      if (await shows("button", "Return control")) {
        await click("button", "Return control");
        await waitFor("button", "Take control", { "timeout-ms": 60_000 });
      }
      const { submit } = PLATFORMS[platform];
      let current = await observe(platform, chain.dryRun);
      if (submit) {
        const target = current.observation.nodes.find(
          (node) =>
            node.role === submit.role &&
            node.name === submit.name &&
            !node.covered
        );
        if (target) {
          await device(platform, {
            _tag: "input",
            action: { _tag: "activate", target: target.target },
            observationId: current.observation.id,
            operationId: operation("activate"),
            sessionId: chain.dryRun,
          });
          current = await observe(platform, chain.dryRun);
        }
      }
      await device(platform, {
        _tag: "complete",
        assessment: {
          explanation: `The agent entered ${publicName} and reached the outcome.`,
          observationId: current.observation.id,
          outcome: "working",
        },
        operationId: operation("complete"),
        sessionId: chain.dryRun,
      });
    },
    "dry-run": async ({ chain, entry, platform }) => {
      const { field, prepare } = PLATFORMS[platform];
      await stopAndClose(platform, entry.sessionId);
      const { flowName, recordingId, selection } = entry.native;
      const started = await device(platform, {
        _tag: "start",
        flowName,
        kind: "dry-run",
        operationId: operation("dry"),
        recordingId,
        selection,
      });
      chain.dryRun = started.id;
      await goto(viewUrl(platform, started.id));
      const prepared = await read(platform, started.id);
      if (
        prepared.preparation?.pending?.some(
          (decision) => decision.kind === "app-installation"
        )
      ) {
        await click("button", "Allow");
      }
      await waitFor("button", prepare, { "timeout-ms": 120_000 });
      await click("button", prepare);
      await waitFor("button", "Take control", { "timeout-ms": 180_000 });
      // The agent's first touch, drawn on the screen as its dot.
      const current = await observe(platform, started.id);
      const target = current.observation.nodes.find(
        (node) =>
          node.role === field.role && node.name === field.name && !node.covered
      );
      if (!target) {
        throw new Error(`The Dry Run shows no ${field.name}.`);
      }
      await device(platform, {
        _tag: "input",
        action: { _tag: "fill", target: target.target, text: publicName },
        observationId: current.observation.id,
        operationId: operation("fill"),
        sessionId: started.id,
      });
    },
    record: ({ entry, platform }) =>
      recordJourney(platform, entry.sessionId, { pin: true }),
  };

  // States ------------------------------------------------------------------
  const chainFor = (platform, key, ended) => {
    const p = PLATFORMS[platform];
    const ready = `${platform}-teaching-ready`;
    const derived = (name, surface, built, prototype) => ({
      alive: kit.always,
      build: (context) => {
        const { holder = "user", ...rest } = built;
        return {
          ...context.entry(ready),
          ...rest,
          actions: [
            ...(rest.actions ?? []),
            ...(holder === "none" ? [] : [streamed(platform, holder)]),
          ],
        };
      },
      depends: [ready],
      name,
      platform,
      prototype,
      surface,
    });
    const rail = (name, card) =>
      derived(
        `${platform}-${name}`,
        "Native session canvas",
        {
          actions: [{ click: ["button", card] }],
          ready: ["region", card],
        },
        prototypeTeaching(key, [{ click: ["button", card] }])
      );
    const onDryRun = (name, surface, built, prototype) =>
      derived(
        name,
        surface,
        { ...built, url: `@chain:${platform}:dryRun` },
        prototype
      );
    return [
      {
        alive: async (entry) => {
          try {
            const session = await read(platform, entry.sessionId);
            return (
              session.phase === "running" &&
              session.captureState?._tag !== "recording" &&
              (session.instructions?.length ?? 0) === 0
            );
          } catch (error) {
            if (error instanceof kit.RefusalError) {
              return false;
            }
            throw error;
          }
        },
        build: async () => {
          await deviceOf(platform);
          await releaseDevice(platform);
          const learned = await learn(
            platform,
            `seed-${platform}-${kit.stamp}`
          );
          const teaching = await startTeaching(
            platform,
            `seed-${platform}-teach-${kit.stamp}`
          );
          return {
            actions: [streamed(platform, "user")],
            native: learned,
            ready: ["button", "Start recording"],
            sessionId: teaching.id,
            url: viewUrl(platform, teaching.id),
          };
        },
        name: ready,
        platform,
        prototype: prototypeTeaching(key),
        surface: "Native session canvas",
      },
      rail("device-settings", "Device settings"),
      rail("screen-elements", "Screen elements"),
      rail("stream-diagnostics", "Stream diagnostics"),
      derived(
        `${platform}-teaching-recording`,
        "Native session canvas",
        {
          actions: [{ step: "record" }],
          consumed: true,
          ready: ["button", "Stop recording"],
        },
        prototypeTeaching(key, [{ click: ["button", "Start recording"] }])
      ),
      ...(platform === "ios"
        ? [
            derived(
              "ios-field-variable",
              "Native session canvas",
              {
                actions: [
                  { step: "record" },
                  {
                    pick: { name: "Password", role: "secure-text-field" },
                  },
                ],
                consumed: true,
                ready: ["form", "Field Variable"],
              },
              {
                actions: [
                  { click: ["button", "Take control"] },
                  { click: ["button", "Screen elements"] },
                  { click: ["button", "Select Password"] },
                ],
                path: "/s2",
              }
            ),
          ]
        : []),
      derived(
        `${platform}-comment`,
        "Teaching overlays",
        {
          actions: [
            { step: "record" },
            { click: ["button", "Comment"] },
            { wait: ["dialog", "Comment"] },
            { click: ["button", "Attach element"] },
          ],
          consumed: true,
          ready: ["dialog", "Comment"],
        },
        prototypeTeaching(key, [
          { click: ["button", "Start recording"] },
          { click: ["button", "Comment"] },
          { click: ["button", "Attach element"] },
        ])
      ),
      derived(
        `${platform}-agent-driving`,
        "Native session canvas",
        {
          actions: [{ step: "dry-run" }],
          consumed: true,
          holder: "agent",
          ready: ["button", "Take control"],
        },
        platform === "android"
          ? { path: "/s2", review: "session-android-dark.png" }
          : { path: "/s3" }
      ),
      onDryRun(
        `${platform}-takeover`,
        "Interactive Run chrome",
        {
          actions: [{ click: ["button", "Take control"] }],
          consumed: true,
          ready: ["button", "Return control"],
        },
        {
          actions: [{ click: ["button", "Take control"] }],
          path: platform === "android" ? "/s2" : "/s3",
        }
      ),
      onDryRun(
        `${platform}-run-ended`,
        "Run Summary",
        {
          actions: [{ step: "complete" }],
          consumed: true,
          holder: "none",
          ready: [
            "text",
            "Last frame of the session",
            { partial: true, "timeout-ms": 180_000 },
          ],
        },
        ended
      ),
      onDryRun(
        `${platform}-run-summary-task`,
        "Run details",
        // The device summary has no tabs; its Device list is in the one column.
        {
          actions: [],
          consumed: true,
          holder: "none",
          ready: ["region", "Device"],
        },
        {
          ...ended,
          actions: [
            ...(ended.actions ?? []),
            { click: ["tab", "Task", { partial: true }] },
          ],
          review:
            platform === "ios"
              ? "778-summary-native-task-light.png"
              : undefined,
        }
      ),
      // After the chain the device is free again, so the card can choose it.
      {
        alive: kit.always,
        build: async () => {
          const chosen = await deviceOf(platform);
          return {
            actions:
              platform === "android"
                ? [
                    { click: ["combobox", "Device"] },
                    { click: ["option", chosen.serial, { partial: true }] },
                  ]
                : [
                    { click: ["combobox", "Simulator"] },
                    {
                      click: [
                        "option",
                        `${chosen.name} iOS`,
                        { partial: true },
                      ],
                    },
                  ],
            ready: ["button", p.app, { partial: true, "timeout-ms": 120_000 }],
            url: kit.mcpPage(`/?${p.query}=new`),
          };
        },
        name: `home-start-${platform}-device`,
        platform,
        prototype: {
          ...prototypeStart(key),
          review:
            platform === "android"
              ? "start-android-setup.png"
              : "start-ios-dark.png",
        },
        surface: "Workspace home",
      },
    ];
  };

  const states = [
    ...chainFor("android", "2", {
      actions: [{ click: ["button", "End Run"] }],
      path: "/s2",
    }),
    ...chainFor("ios", "3", { path: "/s5" }),
  ];

  /** Native states the real server cannot reach, whatever the flags. */
  const unreached = [
    [
      "android-field-variable",
      "Native session canvas",
      "android",
      "The Field Variable form opens only at a password field, and the Android fixture the chain teaches on (`dev.contingency.checkout`) has none; iOS covers it as `ios-field-variable`.",
    ],
    [
      "ios-guided-question",
      "Request cards",
      "ios",
      "Guided Runs are browser-only: `agent_device_workspace` starts only `teaching`, `dry-run` and `run` sessions, so no iOS session waits on a Guided Run question.",
    ],
  ];

  /** Why a native state is unreached without its flag. */
  const flagReason = (platform) => {
    const p = PLATFORMS[platform];
    return platform === "android"
      ? `Pass \`seed ${p.flag}\` with one running Android emulator (or set ${p.deviceEnv}) and \`${p.app}\` installed.`
      : `Pass \`seed ${p.flag}\` with one booted iOS simulator (or set ${p.deviceEnv}) and \`${p.app}\` installed.`;
  };

  /** A recorded pick on the live display, for actions that name one. */
  const runPick = (platform, sessionId, target) =>
    pick(platform, sessionId, target);

  return { flagReason, runPick, states, steps, unreached };
};
