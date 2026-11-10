/* oxlint-disable eslint/no-await-in-loop -- One proof-owned device runs one journey sequentially. */
// Captures raw agent-device accessibility snapshots from the native widget
// corpus and from apps that ship with the simulator or emulator, so device-free
// tests can replay real native trees through Contingency's observation rules.
//
//   vpx .cursor/skills/verify-contingency/bin/native-snapshot-capture.mjs ios
//   vpx .cursor/skills/verify-contingency/bin/native-snapshot-capture.mjs android --avd Pixel_9
//
// iOS creates, boots, and deletes one proof-owned simulator by exact UDID.
// Android boots one proof-owned emulator instance with -no-snapshot-save and
// kills only that instance. Both refuse to touch an existing device.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../../..");
const skill = path.resolve(import.meta.dirname, "..");
const { createAgentDeviceClient } = await import(
  pathToFileURL(
    path.join(root, "packages/cli/node_modules/agent-device/dist/src/index.js")
  ).href
);
const platform = process.argv.at(2);
assert.ok(platform === "ios" || platform === "android", "ios or android");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const out = path.join(
  root,
  "packages/cli/tests/fixtures/native-snapshots",
  platform
);
const scratch = await mkdtemp(
  path.join(os.tmpdir(), `native-capture-${platform}-`)
);
const ledger = { platform, resources: [], started: new Date().toISOString() };
const evidence = path.join(skill, "artifacts/native-snapshots", platform);
await mkdir(out, { recursive: true });
await mkdir(evidence, { recursive: true });

// Only fields the observation rules read are kept. Android/iOS values of
// password fields are dropped even though the corpus never types a secret.
const KEEP = [
  "index",
  "type",
  "role",
  "subrole",
  "kind",
  "label",
  "value",
  "contentDescription",
  "identifier",
  "rect",
  "enabled",
  "selected",
  "checked",
  "focused",
  "heading",
  "roleDescription",
  "editable",
  "password",
  "placeholder",
  "visibleToUser",
  "userInteractionEnabled",
  "hittable",
  "depth",
  "parentIndex",
  "bundleId",
  "interactionBlocked",
  "ref",
];
const sanitize = (snapshot) =>
  snapshot.nodes.map((node) => {
    const kept = Object.fromEntries(
      KEEP.filter((key) => node[key] !== undefined).map((key) => [
        key,
        node[key],
      ])
    );
    if (
      kept.password === true ||
      /secure/iu.test(`${kept.kind ?? ""}${kept.type ?? ""}`)
    ) {
      delete kept.value;
    }
    return kept;
  });

const client = createAgentDeviceClient({
  cwd: scratch,
  daemonAuthToken: "",
  daemonBaseUrl: "",
  daemonServerMode: "socket",
  daemonTransport: "socket",
  debug: false,
  responseLevel: "full",
  session: `contingency-capture-${process.pid}`,
  stateDir: scratch,
});

let selection;
const options = () => ({ ...selection, requestId: crypto.randomUUID() });
const snapshot = () =>
  client.capture.snapshot({
    ...options(),
    interactiveOnly: false,
    noRecord: true,
  });
// Interactions take a generation-bound ref, as the product sends them.
const findRef = (captured, label, kind) => {
  const node = captured.nodes.find(
    (candidate) =>
      // Material buttons render their text in capitals.
      [candidate.label, candidate.contentDescription].some(
        (name) => name?.toLowerCase() === label.toLowerCase()
      ) &&
      (kind === undefined ||
        candidate.kind === kind ||
        candidate.type?.includes(kind))
  );
  return node === undefined
    ? undefined
    : `@${node.ref.replace(/^@/u, "")}~s${captured.refsGeneration}`;
};
// The tree is settled once two consecutive snapshots agree on every node.
const settle = async () => {
  let previous = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const captured = await snapshot();
    const current = JSON.stringify(
      captured.nodes.map(({ label, rect, type }) => [label, rect, type])
    );
    // A launching app exposes only its application node until its first frame.
    if (current === previous && JSON.parse(current).length > 3) {
      return;
    }
    previous = current;
  }
};
const tap = async (label, kind) => {
  const current = await snapshot();
  const ref = findRef(current, label, kind);
  assert.ok(ref, `No node labelled ${label}`);
  await client.interactions.click({ ...options(), ref, settle: true });
  await settle();
};
const save = async (id, meta, captured) => {
  const nodes = sanitize(captured);
  const document = {
    capturedAt: new Date().toISOString(),
    nodes,
    platform,
    source: meta,
    viewport: captured.viewport ?? null,
  };
  await writeFile(
    path.join(out, `${id}.json`),
    `${JSON.stringify(document, null, 2)}\n`
  );
  return nodes.length;
};
const lastAction = (nodes) =>
  nodes.find((node) => (node.label ?? "").startsWith("Last action:"))?.label ??
  null;

// Probe that the device layer itself can activate each primitive. A probe
// records what changed; it does not decide whether Contingency accepts it.
const probe = async (label, kind) => {
  const before = await snapshot();
  const ref = findRef(before, label, kind);
  if (ref === undefined) {
    return { found: false, label };
  }
  try {
    await client.interactions.click({ ...options(), ref, settle: true });
  } catch (error) {
    return {
      error: String(error?.code ?? error?.message ?? error),
      found: true,
      label,
    };
  }
  await settle();
  const after = await snapshot();
  return {
    after: lastAction(after.nodes),
    before: lastAction(before.nodes),
    found: true,
    label,
  };
};

const iosSetup = async () => {
  const runtime = flag(
    "runtime",
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5"
  );
  const deviceType = flag(
    "device-type",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
  );
  const { stdout } = await execute("xcrun", [
    "simctl",
    "create",
    `contingency-capture-${process.pid}`,
    deviceType,
    runtime,
  ]);
  const udid = stdout.trim();
  ledger.resources.push({ kind: "simulator", udid });
  await execute("xcrun", ["simctl", "boot", udid]);
  await execute("xcrun", ["simctl", "bootstatus", udid, "-b"], {
    timeout: 600_000,
  });
  const build = path.join(scratch, "build");
  await execute("sh", [
    path.join(skill, "fixtures/ios-widgets/build.sh"),
    build,
  ]);
  await execute("xcrun", [
    "simctl",
    "install",
    udid,
    path.join(build, "IosWidgets.app"),
  ]);
  selection = { platform: "ios", udid };
  return {
    cleanup: async () => {
      await execute("xcrun", ["simctl", "shutdown", udid]).catch(() => null);
      await execute("xcrun", ["simctl", "delete", udid]);
      ledger.resources.find((entry) => entry.udid === udid).deleted = true;
    },
    device: { deviceType, runtime },
  };
};

const sdk =
  process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
const adb = path.join(sdk, "platform-tools/adb");
const androidSetup = async () => {
  const avd = flag("avd", "Pixel_9");
  const port = Number(flag("port", "5584"));
  const serial = `emulator-${port}`;
  const { stdout: devices } = await execute(adb, ["devices"]);
  assert.ok(
    !devices.includes(serial),
    `${serial} already exists; pass another --port`
  );
  const emulator = spawn(
    path.join(sdk, "emulator/emulator"),
    [
      "-avd",
      avd,
      "-port",
      String(port),
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      "-no-window",
      "-read-only",
    ],
    { stdio: "ignore" }
  );
  ledger.resources.push({ kind: "emulator", pid: emulator.pid, serial });
  await execute(adb, ["-s", serial, "wait-for-device"], { timeout: 600_000 });
  // Boot completion is a device property, so this waits on the device's own signal.
  await execute(
    adb,
    [
      "-s",
      serial,
      "shell",
      'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
    ],
    { timeout: 600_000 }
  );
  const apk = flag("apk");
  if (apk !== undefined) {
    await execute(adb, ["-s", serial, "install", "-r", apk]);
  }
  selection = { platform: "android", serial };
  return {
    cleanup: async () => {
      await execute(adb, ["-s", serial, "emu", "kill"]).catch(() => null);
      if (emulator.exitCode === null) {
        await once(emulator, "exit");
      }
      ledger.resources.find((entry) => entry.serial === serial).stopped = true;
    },
    device: { avd },
  };
};

const IOS_CORPUS = "dev.contingency.ioswidgets";
const ANDROID_CORPUS = "dev.contingency.physicalfixture";
// Apps that ship with the platform image: real production trees with no
// user data on a fresh device.
const BUILT_IN = {
  android: [
    ["settings", "com.android.settings"],
    ["contacts", "com.google.android.contacts"],
    ["clock", "com.google.android.deskclock"],
    ["calendar", "com.google.android.calendar"],
    ["files", "com.google.android.documentsui"],
    ["chrome", "com.android.chrome"],
    ["play-store", "com.android.vending"],
    ["messages", "com.google.android.apps.messaging"],
  ],
  ios: [
    ["settings", "com.apple.Preferences"],
    ["contacts", "com.apple.MobileAddressBook"],
    ["calendar", "com.apple.mobilecal"],
    ["reminders", "com.apple.reminders"],
    ["files", "com.apple.DocumentsApp"],
    ["health", "com.apple.Health"],
    ["maps", "com.apple.Maps"],
    ["safari", "com.apple.mobilesafari"],
    ["photos", "com.apple.mobileslideshow"],
    ["wallet", "com.apple.Passbook"],
  ],
};

const IOS_PROBES = [
  ["Notifications"],
  ["Size"],
  ["Medium"],
  ["Quantity"],
  ["Quantity, Increment"],
  ["Favorite"],
  ["Continue"],
  ["Unavailable"],
  ["Delivery date"],
];

const ANDROID_PROBES = [
  ["Notifications"],
  ["Gift wrap"],
  ["Express"],
  ["Favorite"],
  ["Continue"],
  ["Unavailable"],
  // Last: the spinner opens a dropdown that the capture dismisses with Back.
  ["Size"],
];

const run = async () => {
  const setup = platform === "ios" ? await iosSetup() : await androidSetup();
  ledger.device = setup.device;
  const results = { probes: [], skipped: [], snapshots: [] };
  try {
    const corpus = platform === "ios" ? IOS_CORPUS : ANDROID_CORPUS;
    const corpusInstalled = platform === "ios" || flag("apk") !== undefined;
    if (corpusInstalled) {
      const openCorpus = { ...options(), app: corpus, noRecord: true };
      if (platform === "android") {
        openCorpus.activity = ".WidgetsActivity";
      }
      await client.apps.open(openCorpus);
      await settle();
      const meta = (screen) => ({ app: corpus, corpus: true, screen });
      results.snapshots.push([
        "corpus-controls",
        await save("corpus-controls", meta("controls"), await snapshot()),
      ]);
      await tap("Show alert");
      results.snapshots.push([
        "corpus-alert",
        await save("corpus-alert", meta("alert"), await snapshot()),
      ]);
      await tap("Cancel");
      if (platform === "ios") {
        await tap("Show action sheet");
        results.snapshots.push([
          "corpus-action-sheet",
          await save(
            "corpus-action-sheet",
            meta("action-sheet"),
            await snapshot()
          ),
        ]);
        await tap("Cancel");
        await tap("Show promo");
        results.snapshots.push([
          "corpus-modal",
          await save("corpus-modal", meta("modal"), await snapshot()),
        ]);
        await tap("Close promo");
        for (const [label, kind] of IOS_PROBES) {
          results.probes.push(await probe(label, kind));
        }
        await tap("List");
        results.snapshots.push([
          "corpus-list",
          await save("corpus-list", meta("list"), await snapshot()),
        ]);
        results.probes.push(await probe("Anvil"), await probe("Edit"));
        await tap("Web");
        await settle();
        results.snapshots.push([
          "corpus-web",
          await save("corpus-web", meta("web"), await snapshot()),
        ]);
        results.probes.push(await probe("Apply coupon"));
      } else {
        await tap("Show bottom sheet");
        results.snapshots.push([
          "corpus-bottom-sheet",
          await save(
            "corpus-bottom-sheet",
            meta("bottom-sheet"),
            await snapshot()
          ),
        ]);
        await tap("Close sheet");
        for (const [label, kind] of ANDROID_PROBES) {
          results.probes.push(await probe(label, kind));
        }
        results.snapshots.push([
          "corpus-spinner-open",
          await save(
            "corpus-spinner-open",
            meta("spinner-open"),
            await snapshot()
          ),
        ]);
        await client.command.back({ ...options() });
        await settle();
        await tap("List");
        results.snapshots.push([
          "corpus-list",
          await save("corpus-list", meta("list"), await snapshot()),
        ]);
        results.probes.push(await probe("Anvil"), await probe("Product 3"));
        await tap("Web");
        await settle();
        results.snapshots.push([
          "corpus-web",
          await save("corpus-web", meta("web"), await snapshot()),
        ]);
      }
    }
    let systemAlertSaved = false;
    for (const [id, app] of BUILT_IN[platform]) {
      try {
        await client.apps.open({ ...options(), app, noRecord: true });
        await settle();
        // A first launch can raise a system permission prompt over the app.
        // Keep the first one as its own sample, then refuse it so the app's
        // own tree is what this entry records.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await snapshot();
          const refuse = current.nodes.find((node) =>
            ["Don’t Allow", "Don't Allow", "Not Now", "Deny"].includes(
              node.label ?? ""
            )
          );
          if (refuse === undefined) {
            break;
          }
          if (!systemAlertSaved) {
            results.snapshots.push([
              "system-permission-alert",
              await save(
                "system-permission-alert",
                { app, corpus: false, screen: "permission-alert" },
                current
              ),
            ]);
            systemAlertSaved = true;
          }
          await client.interactions.click({
            ...options(),
            ref: `@${refuse.ref.replace(/^@/u, "")}~s${current.refsGeneration}`,
            settle: true,
          });
          await settle();
        }
        results.snapshots.push([
          id,
          await save(
            id,
            { app, corpus: false, screen: "launch" },
            await snapshot()
          ),
        ]);
      } catch (error) {
        results.skipped.push({
          app,
          reason: String(error?.code ?? error?.message ?? error),
        });
      }
    }
  } finally {
    await client.sessions.close({}).catch(() => null);
    // The SDK starts a private daemon in the scratch state directory; stop it
    // before deleting that directory so no orphan outlives the capture.
    await execute(process.execPath, [
      path.join(
        root,
        "packages/cli/node_modules/agent-device/bin/agent-device.mjs"
      ),
      "daemon",
      "stop",
      "--state-dir",
      scratch,
    ]).catch((error) => {
      ledger.daemonStopFailed = String(error?.message ?? error);
    });
    await setup.cleanup();
    await rm(scratch, { force: true, recursive: true });
    ledger.finished = new Date().toISOString();
  }
  return results;
};

const results = await run();
await writeFile(
  path.join(evidence, "receipt.json"),
  `${JSON.stringify({ ...ledger, ...results }, null, 2)}\n`
);
console.log(JSON.stringify({ ...ledger, ...results }, null, 2));
