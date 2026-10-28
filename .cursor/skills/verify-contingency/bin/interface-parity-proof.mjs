#!/usr/bin/env node
// Identical native calls through brokerTool on both interfaces. No model runs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { androidPrerequisite } from "./interface-eval/android.mjs";
import { Effect, Resources, memory } from "./interface-eval/runtime.mjs";

const execute = promisify(execFile);
const control = path.join(import.meta.dirname, "control-contingency");
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(directory, "Launch an isolated verification instance first.");
const phase = process.argv[2] ?? "boundary";
assert.ok(["boundary", "cancellation", "android"].includes(phase));
const instance = JSON.parse(
  await readFile(path.join(directory, "instance.json"), "utf-8")
);
const proofId = `parity-${Date.now()}`;
const artifacts = path.resolve(
  import.meta.dirname,
  `../artifacts/interface-parity/${proofId}-${phase}-${instance.mcpInterface ?? "single-tool"}`
);
await mkdir(artifacts, { recursive: true });
const resources = new Resources(artifacts);
const journal = [];
const save = (name, value) =>
  writeFile(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`);
const command = async (...args) => {
  try {
    const pending = execute("nub", [control, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    resources.roots.add(pending.child.pid);
    resources.inspect();
    const result = await pending;
    journal.push({ args, ...result, exitCode: 0 });
    return result.stdout.trim();
  } catch (error) {
    journal.push({
      args,
      exitCode: error.code,
      stderr: error.stderr,
      stdout: error.stdout,
    });
    throw error;
  }
};
const call = async (tool, params, callId) =>
  JSON.parse(
    await command(
      "mcp",
      "call",
      "--tool",
      tool,
      "--params",
      JSON.stringify(params),
      ...(callId ? ["--call-id", callId] : [])
    )
  );
const snapshot = (sessionId) =>
  call("agent_browser_snapshot", { format: "structured", sessionId });
const cart = (page) =>
  page.nodes.find((node) => /items? in cart$/u.test(node.name))?.name;
const click = (name) =>
  command("browser", "click", "--role", "button", "--name", name);
const capture = async (name) => {
  const relative = path.relative(
    path.resolve(import.meta.dirname, "../artifacts"),
    artifacts
  );
  await command(
    "browser",
    "snapshot",
    "--aria",
    "--path",
    `${relative}/${name}.aria.txt`
  );
  await command("browser", "screenshot", "--path", `${relative}/${name}.png`);
};
const start = () =>
  call("agent_run_start", {
    inputs: [],
    operationId: `${proofId}-start`,
    referencedSkills: [],
    requestedTask: "Add one Giant anvil to the cart",
    url: process.env.ECOMMERCE_URL,
    view: "compact",
  });
const boundary = async () => {
  const session = await start();
  await command("browser", "goto", "--url", session.viewUrl);
  const page = await snapshot(session.id);
  const { ref } = page.nodes.find(
    (node) => node.name === "Add Giant anvil to cart"
  );
  const paused = await call("agent_browser_act_sequence", {
    actions: [
      {
        action: { ref, type: "click" },
        intent: { irreversible: true },
        operationId: `${proofId}-pause`,
      },
      { action: { ref, type: "click" }, operationId: `${proofId}-later` },
    ],
    format: "structured",
    sessionId: session.id,
  });
  await save("paused.json", paused);
  assert.equal(cart(await snapshot(session.id)), "0 items in cart");
  const state = await call("agent_session_get", {
    sessionId: session.id,
    view: "full",
  });
  assert.equal(state.timeline.length, 1, "no later sequence action dispatched");
  const [attempt] = state.timeline;
  assert.equal(attempt.dispatched, false);
  const [{ boundaryId }] = state.pendingDecisions;
  assert.ok(boundaryId);
  await command("browser", "wait", "--role", "button", "--name", "Allow");
  await capture("paused");
  await click("Allow");
  const params = { boundaryId, format: "structured", sessionId: session.id };
  // Two requests deliberately race the same stored attempt, not two stacks.
  const resumed = await Promise.all([
    call("agent_browser_resume", params),
    call("agent_browser_resume", params),
  ]);
  assert.equal(resumed[0].entry.id, resumed[1].entry.id);
  const replay = await call("agent_browser_resume", params);
  assert.equal(replay.entry.id, resumed[0].entry.id);
  const after = await call("agent_session_get", {
    sessionId: session.id,
    view: "full",
  });
  assert.equal(after.timeline.filter((entry) => entry.dispatched).length, 1);
  assert.equal(
    after.timeline.filter((entry) => entry.id === resumed[0].entry.id).length,
    1
  );
  assert.equal(cart(await snapshot(session.id)), "1 item in cart");
  assert.equal(after.decisionHistory.at(-1).source, "workspace");
  await save("resumed.json", { after, resumed });
  await capture("resumed");
  return { concurrentAttemptId: resumed[0].entry.id, laterDispatched: false };
};
const cancellation = async () => {
  const session = await start();
  const { promise: arrival, resolve: received } = Promise.withResolvers();
  let response;
  let requests = 0;
  const server = createServer((request, reply) => {
    if (request.url === "/held") {
      requests += 1;
      response = reply;
      received();
    } else {
      reply.end("ready");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  resources.trackServer(
    server,
    "held navigation; response released after MCP cancellation"
  );
  const params = {
    action: {
      type: "navigate",
      url: `http://127.0.0.1:${server.address().port}/held`,
    },
    operationId: `${proofId}-navigate`,
    sessionId: session.id,
  };
  const pending = call("agent_browser_act", params, `${proofId}-cancel`);
  // The fixture request is the dispatch signal. One hang guard only.
  await Effect.runPromise(
    Effect.tryPromise(() => arrival).pipe(Effect.timeout("30 seconds"))
  );
  const cancel = await command(
    "mcp",
    "cancel",
    "--call-id",
    `${proofId}-cancel`
  );
  assert.equal(JSON.parse(cancel).cancelled, true);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  response.end("<title>Held navigation complete</title>");
  let replay;
  try {
    replay = await call("agent_browser_act", params);
    assert.ok(replay.entry, "retry returns the recorded attempt");
  } catch (error) {
    assert.match(
      `${error.stdout ?? ""}${error.stderr ?? ""}${String(error)}`,
      /dispatched but its outcome is unknown/u
    );
    replay = { uncertain: true };
  }
  const after = await call("agent_session_get", {
    sessionId: session.id,
    view: "full",
  });
  assert.equal(requests, 1, "retry never navigates again");
  assert.ok(
    replay.uncertain ||
      after.timeline.some((entry) => entry.id === replay.entry.id),
    "the retry returns a recorded attempt or refuses an uncertain dispatch"
  );
  await save("cancellation.json", {
    after,
    cancel: JSON.parse(cancel),
    replay,
    requests,
  });
  return {
    deadline: "not applicable to native; interpreter-only",
    memoryLimit: "not applicable to native; interpreter-only",
    requests,
  };
};
const android = async () => {
  const device = androidPrerequisite();
  const androidCall = (commandValue) =>
    call("agent_android_workspace", { command: commandValue });
  const session = await androidCall({
    _tag: "start",
    agentSetup: true,
    flowSkillName: proofId,
    kind: "teaching",
    operationId: `${proofId}-start`,
    recordingId: null,
    selection: {
      ...device.selection,
      privateInput: true,
    },
  });
  await command(
    "browser",
    "goto",
    "--url",
    `${instance.mcpUrl}?android=${session.id}`
  );
  await command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Prepare selected emulator",
    "--timeout-ms",
    "90000"
  );
  await click("Prepare selected emulator");
  await command("browser", "android-idle");
  const before = await androidCall({
    _tag: "observe",
    image: false,
    sessionId: session.id,
  });
  const field = before.observation.nodes.find(
    (node) => node.role === "text-field" && node.name === "Shopper name"
  );
  assert.ok(field);
  await androidCall({
    _tag: "input",
    action: { _tag: "fill", target: field.target, text: "461" },
    observationId: before.observation.id,
    operationId: `${proofId}-fill`,
    sessionId: session.id,
  });
  const after = await androidCall({
    _tag: "observe",
    image: false,
    sessionId: session.id,
  });
  assert.ok(
    after.observation.nodes.some(
      (node) => node.role === "text-field" && node.name === "461"
    )
  );
  await androidCall({
    _tag: "variable-request",
    name: "SETUP_PASSWORD",
    operationId: `${proofId}-variable`,
    purpose: "Sign in privately",
    replace: false,
    sessionId: session.id,
  });
  await command(
    "browser",
    "wait",
    "--role",
    "button",
    "--name",
    "Refuse SETUP_PASSWORD"
  );
  await capture("variable-requested");
  await click("Refuse SETUP_PASSWORD");
  await command("browser", "android-idle");
  const read = await androidCall({ _tag: "read", sessionId: session.id });
  assert.deepEqual(
    read.variables.map(({ name, status }) => [name, status]),
    [["SETUP_PASSWORD", "refused"]]
  );
  await save("android.json", { after, variables: read.variables });
  await click("Close session");
  await command("browser", "wait", "--text", "Closed", "--timeout-ms", "90000");
  return {
    action: "public fill read back",
    intervention: "private Variable refused in Workspace",
    serial: device.serial,
  };
};
try {
  await save("memory.json", memory());
  const result = await Effect.runPromise(
    Effect.tryPromise({
      catch: (error) => error,
      try: { android, boundary, cancellation }[phase],
    })
  );
  await save("result.json", {
    interface: instance.mcpInterface ?? "single-tool",
    phase,
    result,
    status: "passed",
  });
  process.stdout.write(`${artifacts}\n`);
} catch (error) {
  await save("result.json", {
    error: String(error),
    phase,
    stack: error.stack,
    status: "failed",
  });
  process.exitCode = 1;
} finally {
  await save("commands.json", journal);
  await resources.cleanup();
}
