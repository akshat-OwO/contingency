// Workspace gestures and navigation must run in order on the selected device.
/* oxlint-disable eslint/no-await-in-loop */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  androidComment,
  androidIdle,
  androidPick,
  openAndroidSheet,
} from "./android-ui.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href);
const execute = promisify(execFile);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(
  directory,
  "Set CONTINGENCY_VERIFY_DIR to the owned verification instance."
);
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
assert.ok(instance.mcpUrl, "Start this instance's MCP broker first.");
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/android-workspace"
);
await mkdir(artifacts, { mode: 0o700, recursive: true });
const journal = [];
let sequence = 0;
const operation = () => {
  sequence += 1;
  return `android-workspace-proof-${process.pid}-${sequence}`;
};
const control = (...args) =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        execute(
          "nub",
          [
            path.join(
              root,
              ".cursor/skills/verify-contingency/bin/control-contingency"
            ),
            ...args,
          ],
          {
            cwd: root,
            env: process.env,
            maxBuffer: 8 * 1024 * 1024,
          }
        ),
    }).pipe(
      Effect.tap(({ stdout }) =>
        Effect.sync(() => journal.push({ args, stdout }))
      ),
      Effect.map(({ stdout }) => stdout)
    )
  );
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
const command = (input) =>
  tool("agent_device_workspace", { command: input, platform: "android" });
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
const wait = (name, role = "button") =>
  control(
    "browser",
    "wait",
    "--role",
    role,
    "--name",
    name,
    "--timeout-ms",
    "60000"
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
let selection = {
  device: {
    api: 36,
    avd: process.env.CONTINGENCY_ANDROID_AVD,
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial: process.env.CONTINGENCY_ANDROID_SERIAL,
  },
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.contingency.checkout",
    startingState: "group Fixture Shop sign in is visible",
  },
  helperConsent: "none",
  outcomes: [{ name: "Catalog", role: "group" }],
  setup: {
    activity: "dev.contingency.checkout/.MainActivity",
    conditions: [{ name: "Fixture Shop sign in", role: "group" }],
    kind: "restart-activity",
  },
};
assert.ok(
  Object.values(selection.device).every((value) => value !== undefined),
  "Supply the explicitly authorized device declarations."
);
const prepareName = "Prepare selected emulator";
const flowSkillName = `android-public-field-${process.pid}`;
const publicText = "Public fixture 470";
let recordingId;
const receipt = {
  blockers: [],
  coverage: {},
  device: selection.device,
  feature: "android-workspace",
  flowSkillName,
};
const read = (sessionId) => command({ _tag: "read", sessionId });
const observe = (sessionId) =>
  command({ _tag: "observe", image: false, sessionId });
const input = (session, action) =>
  command({
    _tag: "input",
    action,
    observationId: session.observation.id,
    operationId: operation(),
    sessionId: session.id,
  });
const openView = async (sessionId) => {
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${sessionId}`
  );
  await wait(prepareName);
  await click(prepareName);
  await wait("Take control");
};
const journey = async (sessionId) => {
  let current = await observe(sessionId);
  const field = current.observation.nodes.find(
    (node) =>
      node.role === "text-field" &&
      node.name === "Shopper name" &&
      !node.covered
  );
  assert.ok(
    field,
    "Install the working checkout fixture before this Workspace proof."
  );
  await input(current, {
    _tag: "fill",
    target: field.target,
    text: publicText,
  });
  current = await observe(sessionId);
  assert.ok(
    current.observation.nodes.some((node) => node.name.includes(publicText)),
    "Public text has no semantic readback."
  );
  const signIn = current.observation.nodes.find(
    (node) => node.role === "button" && node.name === "Sign in" && !node.covered
  );
  assert.ok(signIn, "No visible fixture Sign in button.");
  await input(current, { _tag: "activate", target: signIn.target });
  current = await observe(sessionId);
  assert.ok(
    current.observation.nodes.some(
      (node) =>
        node.name === "Catalog" && node.role === "group" && !node.covered
    )
  );
  return current;
};

try {
  await control("browser", "goto", "--url", instance.mcpUrl);
  await openAndroidSheet(control, selection, flowSkillName, snapshot);
  await wait(prepareName);
  await click(prepareName);
  await wait("Start recording");
  await click("Start recording");
  await wait("Stop recording");
  await snapshot("teaching-started");
  const listedSessions = await tool("agent_device_sessions_list", {
    platform: "android",
  });
  const taughtSession = listedSessions.find(
    (session) =>
      session.flowSkillName === flowSkillName && session.kind === "teaching"
  );
  assert.ok(taughtSession);
  assert.deepEqual(taughtSession.selection.device, selection.device);
  ({ selection } = taughtSession);
  ({ recordingId } = taughtSession);
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${taughtSession.id}`
  );
  await androidPick(control, taughtSession.id, "text-field", "Shopper name");
  await control(
    "browser",
    "fill",
    "--role",
    "textbox",
    "--name",
    "Text for Shopper name",
    "--value",
    publicText
  );
  await click("Type");
  await androidIdle(control);
  let current = await observe(taughtSession.id);
  assert.ok(
    current.observation.nodes.some((node) => node.name.includes(publicText)),
    "Workspace fill has no readback."
  );
  await androidPick(control, taughtSession.id, "button", "Sign in");
  await androidComment(
    control,
    "Use only this public fixture name. Catalog proves sign-in worked."
  );
  await click("Stop recording");
  await control(
    "browser",
    "wait",
    "--text",
    "Ask an agent to learn this recording.",
    "--partial"
  );
  current = await read(taughtSession.id);
  assert.equal(current.captureState._tag, "ready");
  await snapshot("teaching-stopped");
  await click("Close session");
  // Close must release this exact device before a fresh Dry Run acquires it.
  await control(
    "browser",
    "wait",
    "--text",
    "This session released its emulator."
  );
  await tool("agent_teaching_recording_claim", {
    action: "take",
    claimOperationId: null,
    error: null,
    operationId: "android-workspace-claim",
    recordingId,
  });
  const timeline = await tool("agent_teaching_timeline_get", {
    claimOperationId: "android-workspace-claim",
    cursor: 0,
    recordingId,
  });
  const actions = timeline.entries.filter((entry) => entry._tag === "action");
  assert.equal(actions.filter((entry) => entry.kind === "activate").length, 1);
  assert.equal(actions.filter((entry) => entry.kind === "fill").length, 1);
  assert.equal(actions.length, 2);
  assert.ok(JSON.stringify(timeline).includes(publicText));
  await writeFile(
    path.join(artifacts, "timeline.json"),
    JSON.stringify(timeline, null, 2)
  );
  await tool("agent_flow_skill_save", {
    claimOperationId: "android-workspace-claim",
    files: [
      {
        content: `---\nname: ${flowSkillName}\ndescription: Enter a public fixture name and sign in to the disposable Android checkout app. Use when checking experimental Workspace input.\ninputs:\n---\n\n# Enter public fixture text\n\n1. Enter ${publicText} in Shopper name. Done when: ${publicText} is visible.\n2. Activate Sign in. Done when: Catalog is visible.\n`,
        path: "SKILL.md",
      },
    ],
    operationId: operation(),
    recordingId,
  });
  const saved = await readFile(
    path.join(instance.stateDir, "catalog", flowSkillName, "SKILL.md"),
    "utf-8"
  );
  assert.ok(
    saved.includes('"platform":"android"') &&
      !saved.includes("emulation:") &&
      !saved.includes("hosts:")
  );
  receipt.coverage.teaching = {
    actions: actions.map((entry) => entry.description),
    androidStamped: true,
    ready: true,
    recordingId,
  };

  const taken = await command({
    _tag: "start",
    flowSkillName,
    kind: "dry-run",
    operationId: operation(),
    recordingId,
    selection,
  });
  await openView(taken.id);
  await click("Take control");
  await wait("Return control");
  current = await observe(taken.id);
  let blocked = false;
  try {
    await input(current, { _tag: "back" });
  } catch {
    blocked = true;
  }
  assert.ok(blocked, "Agent input was available during Takeover.");
  await click("Return control");
  await wait("Take control");
  current = await observe(taken.id);
  const incomplete = await command({
    _tag: "complete",
    assessment: {
      explanation: "The starting screen is visible after Takeover.",
      observationId: current.observation.id,
      outcome: "working",
    },
    operationId: operation(),
    sessionId: taken.id,
  });
  assert.equal(incomplete.captureState._tag, "dry-run-failed");
  assert.equal(incomplete.assessment.outcome, "inconclusive");
  receipt.coverage.takeover = { agentBlocked: true, passingRefused: true };

  const dry = await command({
    _tag: "start",
    flowSkillName,
    kind: "dry-run",
    operationId: operation(),
    recordingId,
    selection,
  });
  await openView(dry.id);
  current = await journey(dry.id);
  const passed = await command({
    _tag: "complete",
    assessment: {
      explanation:
        "Public text was independently observed and Catalog is visible.",
      observationId: current.observation.id,
      outcome: "working",
    },
    operationId: operation(),
    sessionId: dry.id,
  });
  assert.equal(passed.captureState._tag, "dry-run-passed");
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${dry.id}`
  );
  await wait("Verify flow");
  await snapshot("dry-run-passed");
  await click("Verify flow");
  await control("browser", "wait", "--text", "Recording deleted");
  const verified = await read(dry.id);
  assert.equal(verified.cleanup._tag, "purged");
  assert.equal(verified.observation, null);
  await snapshot("verified-cleanup");
  // Purge removes the Recording directory once the manifest is final.
  assert.equal(
    existsSync(
      path.join(instance.stateDir, "catalog/.recordings", recordingId)
    ),
    false
  );
  const verification = await readFile(
    path.join(
      instance.stateDir,
      "catalog",
      flowSkillName,
      "references/verification.md"
    ),
    "utf-8"
  );
  assert.ok(
    verification.includes("- Platform: android") &&
      verification.includes("- Verified:")
  );
  receipt.coverage.verification = {
    dryRunId: dry.id,
    explicitWorkspaceChoice: true,
    purged: true,
    verifiedSkillRetained: true,
  };

  const later = await command({
    _tag: "start",
    flowSkillName,
    kind: "run",
    operationId: operation(),
    recordingId: null,
    selection,
  });
  await openView(later.id);
  current = await journey(later.id);
  const completed = await command({
    _tag: "complete",
    assessment: {
      explanation:
        "The later Run independently observed public input and Catalog.",
      observationId: current.observation.id,
      outcome: "working",
    },
    operationId: operation(),
    sessionId: later.id,
  });
  assert.equal(completed.assessment.outcome, "working");
  await control(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${later.id}`
  );
  await wait("Run Summary", "complementary");
  await snapshot("later-run-summary");
  receipt.coverage.laterRun = {
    assessment: completed.assessment,
    captureGaps: completed.captureGaps,
    id: later.id,
  };

  // A restarted server owns no device; it reads the retained Summaries.
  await control("mcp", "stop");
  await control("mcp", "start");
  const reopenedDry = await read(dry.id);
  assert.equal(reopenedDry.captureState._tag, "verified");
  assert.equal(reopenedDry.cleanup._tag, "purged");
  const reopenedLater = await read(later.id);
  assert.equal(reopenedLater.assessment.outcome, "working");
  receipt.coverage.restart = { dryRunVerified: true, laterRunRetained: true };
} catch (error) {
  receipt.blockers.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    const owned = await tool("agent_device_sessions_list", {
      platform: "android",
    });
    for (const session of owned.filter(
      (entry) =>
        entry.flowSkillName === flowSkillName &&
        ["pending", "running", "paused"].includes(entry.phase)
    )) {
      await control(
        "browser",
        "goto",
        "--url",
        `${instance.mcpUrl}?android=${session.id}`
      );
      await click("Close session");
      await wait("New session");
      const closedSession = await command({
        _tag: "read",
        sessionId: session.id,
      });
      assert.equal(closedSession.phase, "closed");
    }
  } catch (error) {
    receipt.blockers.push(`Owned session cleanup failed: ${String(error)}`);
    process.exitCode = 1;
  }

  await writeFile(
    path.join(artifacts, "journal.json"),
    JSON.stringify(journal, null, 2),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(artifacts, "receipt.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
