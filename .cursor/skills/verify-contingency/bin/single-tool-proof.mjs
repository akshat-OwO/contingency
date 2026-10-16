#!/usr/bin/env node
// Single-tool interface proof (ADR 0059, #460) against a control-contingency
// instance whose MCP was started with CONTINGENCY_MCP_INTERFACE=single-tool.
// Every agent step is one `agent_code_execute` program; Workspace choices are
// real clicks in the instance's Workspace.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const cliRoot = path.resolve(import.meta.dirname, "../../../../packages/cli");
const { Effect } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("effect", { paths: [cliRoot] })
  ).href
);
const execute = promisify(execFile);
const control = path.join(import.meta.dirname, "control-contingency");
const phase = process.argv[2] ?? "browser";
assert.ok(["android", "browser"].includes(phase), "Pass browser or android.");
const feature = phase === "android" ? "single-tool-android" : "single-tool";
const artifacts = path.resolve(import.meta.dirname, `../artifacts/${feature}`);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
const shop = process.env.ECOMMERCE_URL;
assert.ok(directory, "Launch the verification instance first.");
const io = (action) => Effect.tryPromise(action);
const proofId = Date.now();
const operation = (name) => `single-tool-${proofId}-${name}`;
let sequence = 0;
const journal = [];

const save = (name, value) =>
  io(() =>
    writeFile(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`)
  );

const command = (...args) =>
  io(async () => {
    journal.push({ args, entryPoint: "control-contingency" });
    const { stdout } = await execute("nub", [control, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  });

/** One execution: a fresh interpreter process running `code`. */
const program = (name, code, timeoutMs = 30_000) =>
  Effect.gen(function* executeProgram() {
    journal.push({ code, entryPoint: "agent_code_execute", name, timeoutMs });
    const stdout = yield* command(
      "mcp",
      "call",
      "--tool",
      "agent_code_execute",
      "--params",
      JSON.stringify({ code, timeoutMs })
    );
    const result = JSON.parse(stdout);
    yield* save(`${String((sequence += 1)).padStart(2, "0")}-${name}.json`, {
      code,
      result,
      timeoutMs,
    });
    return result;
  });

const capture = (name) =>
  Effect.gen(function* captureWorkspace() {
    yield* command(
      "browser",
      "snapshot",
      "--aria",
      "--path",
      `${feature}/${name}.aria.txt`
    );
    yield* command("browser", "screenshot", "--path", `${feature}/${name}.png`);
  });

const pidGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const ADD_ANVIL = `
const page = await tools.agent_browser_snapshot({ sessionId, format: "structured" });
const add = page.nodes.find((node) => node.role === "button" && node.name === "Add Giant anvil to cart");
`;

const cartOf = (snapshot) =>
  snapshot.nodes.find((node) => /items? in cart$/u.test(node.name))?.name;

const fresh = io(async () => {
  await rm(`${artifacts}-previous`, { force: true, recursive: true });
  if (existsSync(artifacts)) {
    await rename(artifacts, `${artifacts}-previous`);
  }
  await mkdir(artifacts, { recursive: true });
});

const browserProof = Effect.gen(function* singleToolProof() {
  assert.ok(shop, "Start the ecommerce fixture and export ECOMMERCE_URL.");
  yield* fresh;
  const { tools } = JSON.parse(yield* command("mcp", "tools"));
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["agent_code_execute"]
  );

  // Search in its own execution: signatures, no operation.
  const searched = yield* program(
    "search",
    'return search({ query: "", limit: 100 }).items.map((item) => item.path.replace("tools.", ""))'
  );
  assert.equal(searched.status, "completed");
  assert.deepEqual(searched.receipts, []);
  for (const name of [
    "agent_android_sessions_list",
    "agent_android_workspace",
    "agent_browser_act",
    "agent_browser_resume",
    "agent_flow_skill_dry_run_start",
    "agent_pending_decision_resolve",
    "agent_session_get",
    "agent_teaching_recording_claim",
  ]) {
    assert.ok(searched.value.includes(name), `search lists ${name}`);
  }
  assert.ok(!searched.value.includes("agent_code_run"));

  // A Run persists across executions; nothing else does.
  const started = yield* program(
    "run-start",
    `const run = await tools.agent_run_start({
      inputs: [],
      operationId: ${JSON.stringify(operation("start"))},
      referencedSkills: [],
      requestedTask: "Add one Giant anvil to the cart",
      url: ${JSON.stringify(shop)},
      view: "compact",
    });
    const leftover = run.id;
    return { eventCursor: run.eventCursor, id: leftover, viewUrl: run.viewUrl };`
  );
  assert.equal(started.status, "completed");
  const { eventCursor, id: sessionId, viewUrl } = started.value;
  const isolated = yield* program(
    "fresh-state",
    `const session = await tools.agent_session_get({ sessionId: ${JSON.stringify(sessionId)}, view: "compact" });
    let left;
    try {
      left = leftover;
    } catch (error) {
      left = null;
    }
    return { id: session.id, leftover: left };`
  );
  assert.equal(isolated.value.leftover, null);
  assert.equal(isolated.value.id, sessionId);
  assert.notEqual(isolated.process.pid, started.process.pid);
  yield* command("browser", "goto", "--url", viewUrl);
  yield* command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Take control",
    "--timeout-ms",
    "20000"
  );

  // A full Session Event wait inside one program.
  const waited = yield* program(
    "session-event-wait",
    `const started = Date.now();
    const session = await tools.agent_session_get({
      afterCursor: ${JSON.stringify(eventCursor)},
      sessionId: ${JSON.stringify(sessionId)},
      view: "compact",
      waitMs: 45000,
    });
    return { elapsedMs: Date.now() - started, events: session.events?.length ?? 0 };`,
    60_000
  );
  assert.equal(waited.status, "completed");
  assert.ok(
    waited.value.elapsedMs >= 44_000 && waited.value.elapsedMs < 50_000,
    `waited ${waited.value.elapsedMs} ms`
  );

  // Act, then lose the interpreter to its deadline: the receipt survives.
  const id = JSON.stringify(sessionId);
  const killed = yield* program(
    "act-then-deadline",
    `const sessionId = ${id};${ADD_ANVIL}
    await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, operationId: ${JSON.stringify(operation("add-1"))}, sessionId });
    return /^(a+)+$/.test("a".repeat(40) + "b");`,
    5000
  );
  assert.equal(killed.status, "deadline_exceeded");
  assert.deepEqual(
    killed.receipts.map(({ operation: name, outcome }) => [name, outcome]),
    [
      ["agent_browser_snapshot", "succeeded"],
      ["agent_browser_act", "succeeded"],
    ]
  );
  assert.ok(pidGone(killed.process.pid), "the deadline killed the interpreter");

  // Retrying the same identity reads the recorded attempt.
  const retried = yield* program(
    "retry-same-identity",
    `const sessionId = ${id};${ADD_ANVIL}
    const again = await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, format: "structured", operationId: ${JSON.stringify(operation("add-1"))}, sessionId });
    const session = await tools.agent_session_get({ sessionId, view: "full" });
    return { attempts: session.timeline.filter((entry) => entry.id === again.entry.id).length, clicks: session.timeline.length, entry: again.entry.id, snapshot: again.snapshot };`
  );
  assert.equal(retried.status, "completed");
  assert.equal(retried.value.attempts, 1);
  assert.equal(cartOf(retried.value.snapshot), "1 item in cart");

  // A process failure after an effect keeps that receipt too.
  const exhausted = yield* program(
    "act-then-memory-limit",
    `const sessionId = ${id};${ADD_ANVIL}
    await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, operationId: ${JSON.stringify(operation("add-2"))}, sessionId });
    const hoard = [];
    for (;;) hoard.push("x".repeat(1 << 20) + hoard.length);`
  );
  assert.ok(
    ["memory_limit", "crashed"].includes(exhausted.status),
    exhausted.status
  );
  assert.equal(exhausted.receipts.at(-1).outcome, "succeeded");
  assert.ok(pidGone(exhausted.process.pid));

  // Stopped mid-dispatch: an inspectable uncertain receipt.
  const uncertain = yield* program(
    "deadline-mid-dispatch",
    `await tools.agent_session_get({ afterCursor: ${JSON.stringify(eventCursor)}, sessionId: ${id}, view: "compact", waitMs: 30000 });
    return "unreachable";`,
    1000
  );
  assert.equal(uncertain.status, "deadline_exceeded");
  assert.equal(uncertain.receipts[0].outcome, "uncertain");

  // A Confirmation ends the program: the later click is never dispatched.
  const paused = yield* program(
    "confirmation-refuse",
    `const sessionId = ${id};${ADD_ANVIL}
    await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, intent: { irreversible: true, objective: "Add one Giant anvil to the cart" }, operationId: ${JSON.stringify(operation("confirm-1"))}, sessionId });
    await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, operationId: ${JSON.stringify(operation("after-1"))}, sessionId });
    return "unreachable";`
  );
  assert.equal(paused.status, "intervention");
  assert.equal(paused.intervention.operation, "agent_browser_act");
  assert.deepEqual(paused.intervention.reasons.toSorted(), [
    "boundary",
    "pending_decision",
  ]);
  assert.ok(
    !paused.receipts.some(
      ({ operationId }) => operationId === operation("after-1")
    )
  );
  const refusedBoundary = paused.intervention.pending[0].boundaryId;
  yield* command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Refuse",
    "--timeout-ms",
    "20000"
  );
  yield* capture("confirmation-paused");
  yield* command("browser", "click", "--role", "button", "--name", "Refuse");
  const refused = yield* program(
    "refused-reread",
    `const session = await tools.agent_session_get({ sessionId: ${id}, view: "full" });
    let resumed;
    try {
      await tools.agent_browser_resume({ boundaryId: ${JSON.stringify(refusedBoundary)}, sessionId: ${id} });
      resumed = "dispatched";
    } catch (error) {
      resumed = "refused";
    }
    const page = await tools.agent_browser_snapshot({ sessionId: ${id}, format: "structured" });
    return {
      timeline: session.timeline.length,
      cart: page.nodes.find((node) => /items? in cart$/u.test(node.name))?.name,
      decision: session.decisionHistory.at(-1),
      resumed,
    };`
  );
  assert.equal(refused.value.decision.decision, "refuse");
  assert.equal(refused.value.decision.source, "workspace");
  assert.equal(refused.value.resumed, "refused");
  assert.equal(refused.value.cart, "2 items in cart");

  // Allow in Workspace; two concurrent executions resume one attempt once.
  const allowPaused = yield* program(
    "confirmation-allow",
    `const sessionId = ${id};${ADD_ANVIL}
    await tools.agent_browser_act({ action: { ref: add.ref, type: "click" }, intent: { irreversible: true, objective: "Add one Giant anvil to the cart" }, operationId: ${JSON.stringify(operation("confirm-2"))}, sessionId });
    return "unreachable";`
  );
  assert.equal(allowPaused.status, "intervention");
  const [{ boundaryId }] = allowPaused.intervention.pending;
  yield* command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Allow",
    "--timeout-ms",
    "20000"
  );
  yield* command("browser", "click", "--role", "button", "--name", "Allow");
  const resume = `const resumed = await tools.agent_browser_resume({ boundaryId: ${JSON.stringify(boundaryId)}, format: "structured", sessionId: ${id} });
    return { cart: resumed.snapshot.nodes.find((node) => /items? in cart$/u.test(node.name))?.name, dispatched: resumed.entry.dispatched, id: resumed.entry.id };`;
  const [first, second] = yield* Effect.all(
    [program("resume-a", resume), program("resume-b", resume)],
    { concurrency: "unbounded" }
  );
  assert.equal(first.value.id, second.value.id);
  const reread = yield* program(
    "allowed-reread",
    `const session = await tools.agent_session_get({ sessionId: ${id}, view: "full" });
    const page = await tools.agent_browser_snapshot({ sessionId: ${id}, format: "structured" });
    return {
      attempts: session.timeline.filter((entry) => entry.id === ${JSON.stringify(first.value.id)}).length,
      cart: page.nodes.find((node) => /items? in cart$/u.test(node.name))?.name,
      decision: session.decisionHistory.at(-1),
    };`
  );
  assert.equal(reread.value.decision.decision, "allow");
  assert.equal(reread.value.decision.source, "workspace");
  assert.equal(reread.value.attempts, 1);
  assert.equal(reread.value.cart, "3 items in cart");
  yield* capture("confirmation-allowed");

  // A whole result over the inline limit is kept behind a resource link.
  const whole = yield* program(
    "whole-result",
    `const session = await tools.agent_session_start({
      clientName: "single-tool-proof",
      clientVersion: "1",
      operationId: ${JSON.stringify(operation("large-cart"))},
      url: ${JSON.stringify(new URL("snapshot-cart.html", shop).href)},
      view: "compact",
      viewport: { deviceScaleFactor: 1, height: 720, width: 1024 },
    });
    const page = await tools.agent_browser_snapshot({ sessionId: session.id, format: "structured" });
    await tools.agent_session_close({ operationId: ${JSON.stringify(operation("large-cart-close"))}, sessionId: session.id });
    return page;`
  );
  assert.equal(whole.status, "completed");
  assert.equal(whole.value, undefined);
  assert.ok(
    whole.valueResource.bytes > 16_384,
    `${whole.valueResource.bytes} bytes`
  );
  const kept = yield* command(
    "mcp",
    "resource",
    "--uri",
    whole.valueResource.uri
  );
  assert.equal(Buffer.byteLength(kept), whole.valueResource.bytes);
  assert.ok(kept.startsWith(whole.valueResource.preview));
  const wholeValue = JSON.parse(kept);
  assert.equal(wholeValue.nodes.length, wholeValue.coverage.returned);
  yield* save("whole-result-resource.json", wholeValue);

  const finished = yield* program(
    "complete",
    `await tools.agent_run_assess({ evidence: [{ id: ${JSON.stringify(first.value.id)}, kind: "attempt" }], explanation: "Three anvils were added; the task asked for one.", operationId: ${JSON.stringify(operation("assess"))}, outcome: "not-working", sessionId: ${id} });
    return await tools.agent_run_complete({ operationId: ${JSON.stringify(operation("complete"))}, sessionId: ${id} });`
  );
  const result = {
    concurrentResume: [first.value, second.value],
    finished: finished.status,
    proofId,
    sessionEventWaitMs: waited.value.elapsedMs,
    status: "passed",
    wholeResultBytes: whole.valueResource.bytes,
  };
  yield* save("result.json", result);
  return result;
});

// One Android action and one Android intervention on an explicitly selected
// emulator with the checkout fixture installed. Both interventions end their
// program before the operation after them is dispatched.
const android = (input) =>
  `await tools.agent_android_workspace({ command: ${input} })`;

const androidProof = Effect.gen(function* singleToolAndroidProof() {
  const device = {
    api: Number(process.env.CONTINGENCY_ANDROID_API ?? 36),
    avd: process.env.CONTINGENCY_ANDROID_AVD,
    fingerprint: process.env.CONTINGENCY_ANDROID_FINGERPRINT,
    host: "local",
    serial: process.env.CONTINGENCY_ANDROID_SERIAL,
  };
  assert.ok(
    Object.values(device).every((value) => value !== undefined),
    "Supply the explicitly authorized device declarations."
  );
  yield* fresh;
  const instance = JSON.parse(
    yield* io(() => readFile(path.join(directory, "instance.json"), "utf-8"))
  );
  const selection = {
    device,
    environment: {
      androidVersion: "16",
      appBuild: "1",
      appId: "dev.contingency.checkout",
      startingState: "group Fixture Shop sign in is visible",
    },
    helperConsent: "none",
    outcomes: [{ name: "Catalog", role: "group" }],
    privateHelperConsent:
      process.env.CONTINGENCY_ANDROID_PRIVATE_HELPER_CONSENT ?? "none",
    privateInput: true,
    setup: {
      activity: "dev.contingency.checkout/.MainActivity",
      conditions: [{ name: "Fixture Shop sign in", role: "group" }],
      kind: "restart-activity",
    },
  };

  // Device preparation is the user's: the observe after the start never runs.
  const started = yield* program(
    "android-start",
    `const session = ${android(`{
      _tag: "start",
      agentSetup: true,
      flowSkillName: ${JSON.stringify(`single-tool-android-${proofId}`)},
      kind: "teaching",
      operationId: ${JSON.stringify(operation("android-start"))},
      recordingId: null,
      selection: ${JSON.stringify(selection)},
    }`)};
    ${android('{ _tag: "observe", image: false, sessionId: session.id }')};
    return "unreachable";`
  );
  assert.equal(started.status, "intervention");
  assert.ok(started.intervention.reasons.includes("device_preparation"));
  assert.deepEqual(
    started.receipts.map(({ operation: name, outcome }) => [name, outcome]),
    [["agent_android_workspace", "succeeded"]]
  );
  const { sessionId } = started.intervention;
  const id = JSON.stringify(sessionId);
  yield* command(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${sessionId}`
  );
  yield* command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Prepare selected emulator",
    "--timeout-ms",
    "90000"
  );
  yield* capture("android-preparation");
  yield* command(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Prepare selected emulator"
  );
  yield* command("browser", "android-idle");

  // The Android action: a public fill read back from a fresh observation.
  const filled = yield* program(
    "android-action",
    `const sessionId = ${id};
    const before = ${android('{ _tag: "observe", image: false, sessionId }')};
    const field = before.observation.nodes.find((node) => node.role === "text-field" && node.name === "Shopper name");
    ${android(`{ _tag: "input", action: { _tag: "fill", target: field.target, text: "460" }, observationId: before.observation.id, operationId: ${JSON.stringify(operation("android-fill"))}, sessionId }`)};
    const after = ${android('{ _tag: "observe", image: false, sessionId }')};
    return after.observation.nodes.filter((node) => node.role === "text-field").map((node) => node.name);`,
    60_000
  );
  assert.equal(filled.status, "completed");
  assert.ok(filled.value.includes("460"), JSON.stringify(filled.value));

  // A private Variable request: the user answers in Workspace, so the
  // observe after it never runs.
  const requested = yield* program(
    "android-variable-request",
    `const sessionId = ${id};
    ${android(`{ _tag: "variable-request", name: "SETUP_PASSWORD", operationId: ${JSON.stringify(operation("android-variable"))}, purpose: "Sign in privately", replace: false, sessionId }`)};
    ${android('{ _tag: "observe", image: false, sessionId }')};
    return "unreachable";`
  );
  assert.equal(requested.status, "intervention");
  assert.deepEqual(requested.intervention.reasons, ["variable_requested"]);
  assert.deepEqual(
    requested.receipts.map(({ operation: name, outcome }) => [name, outcome]),
    [["agent_android_workspace", "succeeded"]]
  );
  yield* command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Refuse SETUP_PASSWORD",
    "--timeout-ms",
    "30000"
  );
  yield* capture("android-variable-requested");
  yield* command(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Refuse SETUP_PASSWORD"
  );
  yield* command("browser", "android-idle");
  const reread = yield* program(
    "android-reread",
    `const session = ${android(`{ _tag: "read", sessionId: ${id} }`)};
    return { controller: session.controller, phase: session.phase, variables: session.variables };`
  );
  assert.equal(reread.status, "completed");
  assert.deepEqual(
    reread.value.variables.map(({ name, status }) => [name, status]),
    [["SETUP_PASSWORD", "refused"]]
  );
  yield* capture("android-variable-refused");

  // The whole read, which once came back cut off, is kept behind a link.
  const wholeRead = yield* program(
    "android-whole-read",
    `return ${android(`{ _tag: "read", sessionId: ${id} }`)};`
  );
  assert.equal(wholeRead.status, "completed");
  assert.equal(wholeRead.value, undefined);
  assert.ok(
    wholeRead.valueResource.bytes > 16_384,
    `${wholeRead.valueResource.bytes} bytes`
  );
  const keptRead = yield* command(
    "mcp",
    "resource",
    "--uri",
    wholeRead.valueResource.uri
  );
  assert.equal(Buffer.byteLength(keptRead), wholeRead.valueResource.bytes);
  const session = JSON.parse(keptRead);
  assert.equal(session.id, sessionId);
  assert.deepEqual(
    session.variables.map(({ name, status }) => [name, status]),
    [["SETUP_PASSWORD", "refused"]]
  );
  yield* save("android-whole-read-resource.json", session);
  yield* command(
    "browser",
    "click",
    "--role",
    "button",
    "--name",
    "Close session"
  );
  yield* command(
    "browser",
    "wait",
    "--text",
    "Closed",
    "--timeout-ms",
    "90000"
  );
  const result = {
    device: { avd: device.avd, serial: device.serial },
    proofId,
    sessionId,
    status: "passed",
    variables: reread.value.variables,
    wholeReadBytes: wholeRead.valueResource.bytes,
  };
  yield* save("result.json", result);
  return result;
});

const proof = phase === "android" ? androidProof : browserProof;

await Effect.runPromise(
  proof.pipe(
    Effect.ensuring(save("commands.json", journal).pipe(Effect.ignore))
  )
).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  async (error) => {
    await writeFile(
      path.join(artifacts, "result.json"),
      `${JSON.stringify({ error: String(error), proofId, status: "failed" }, null, 2)}\n`
    );
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
