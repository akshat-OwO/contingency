#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const artifacts = path.resolve(
  import.meta.dirname,
  "../artifacts/session-events"
);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(directory, "Launch the verification instance first.");
const [phase, waitTarget = "teaching", waitKind] = process.argv.slice(2);
const io = (action) => Effect.tryPromise(action);
const operation = () => `session-events-${crypto.randomUUID()}`;
const statePath = path.join(artifacts, "state.json");
const save = (name, value) =>
  io(() =>
    writeFile(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`)
  );
const call = (tool, params) =>
  io(async () => {
    const startedAt = Date.now();
    const { stdout, stderr } = await execute(
      "nub",
      [
        control,
        "mcp",
        "call",
        "--tool",
        tool,
        "--params",
        JSON.stringify(params),
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const result = JSON.parse(stdout);
    await writeFile(
      path.join(artifacts, `call-${startedAt}-${crypto.randomUUID()}.json`),
      JSON.stringify(
        {
          bytes: Buffer.byteLength(stdout),
          exitCode: 0,
          params,
          result,
          stderr,
          tool,
        },
        null,
        2
      )
    );
    return result;
  });
const readState = () =>
  io(async () => JSON.parse(await readFile(statePath, "utf-8")));
const start = Effect.gen(function* startTeaching() {
  const url = process.env.ECOMMERCE_URL;
  assert.ok(url);
  const teaching = yield* call("agent_session_start", {
    activity: "teaching",
    clientName: "session-event-proof",
    clientVersion: "1",
    name: "session-event-cart",
    operationId: operation(),
    url,
    view: "compact",
    viewport: { deviceScaleFactor: 1, height: 720, width: 1000 },
  });
  yield* call("agent_variable_request", {
    name: "PASSWORD",
    operationId: operation(),
    purpose: "Prove private Workspace supply",
    sessionId: teaching.id,
    view: "compact",
  });
  yield* save("state.json", { teaching, url });
  process.stdout.write(`${teaching.viewUrl}\n`);
});
const handoff = Effect.gen(function* handoffTeaching() {
  const state = yield* readState();
  yield* call("agent_teaching_setup_handoff", {
    operationId: operation(),
    sessionId: state.teaching.id,
    view: "compact",
  });
});
const learn = Effect.gen(function* learnRecording() {
  const state = yield* readState();
  const teaching = yield* call("agent_session_get", {
    sessionId: state.teaching.id,
    view: "compact",
  });
  assert.ok(
    ["ready", "learning", "dry-run-failed"].includes(
      teaching.teaching.captureState
    )
  );
  const manifest = yield* io(async () =>
    JSON.parse(
      await readFile(
        path.join(
          directory,
          "state/catalog/.recordings",
          teaching.teaching.recordingId,
          "manifest.json"
        ),
        "utf-8"
      )
    )
  );
  const claimOperationId = manifest.lifecycle.claim?.operationId ?? operation();
  if (manifest.lifecycle.claim === undefined) {
    yield* call("agent_teaching_recording_claim", {
      action: "take",
      operationId: claimOperationId,
      recordingId: teaching.teaching.recordingId,
    });
  }
  const timeline = yield* call("agent_teaching_timeline_get", {
    claimOperationId,
    recordingId: teaching.teaching.recordingId,
  });
  yield* save("timeline.json", timeline);
  yield* call("agent_flow_skill_save", {
    claimOperationId,
    files: [
      {
        content:
          "---\nname: session-event-cart\ndescription: Add one giant anvil to the cart on the disposable shop.\ninputs:\n---\n\n1. Choose Add Giant anvil to cart. Done when: 1 item in cart is visible.\n",
        path: "SKILL.md",
      },
    ],
    operationId: operation(),
    recordingId: teaching.teaching.recordingId,
  });
  const dry = yield* call("agent_flow_skill_dry_run_start", {
    inputs: [],
    operationId: operation(),
    recordingId: teaching.teaching.recordingId,
    url: state.url,
    view: "compact",
  });
  yield* save("state.json", {
    ...state,
    dry: dry.session,
    recordingId: teaching.teaching.recordingId,
  });
  process.stdout.write(`${dry.session.viewUrl}\n`);
});
const pass = Effect.gen(function* passDryRun() {
  const state = yield* readState();
  const snapshot = yield* call("agent_browser_snapshot", {
    format: "structured",
    interactive: false,
    sessionId: state.dry.id,
  });
  const button = snapshot.nodes.find(
    (node) => node.role === "button" && node.name === "Add Giant anvil to cart"
  );
  assert.ok(button);
  if (!JSON.stringify(snapshot).includes("1 item in cart")) {
    yield* call("agent_browser_act", {
      action: { ref: button.ref, type: "click" },
      format: "structured",
      operationId: operation(),
      sessionId: state.dry.id,
    });
  }
  const observed = yield* call("agent_browser_snapshot", {
    format: "text",
    interactive: false,
    sessionId: state.dry.id,
  });
  assert.ok(JSON.stringify(observed).includes("1 item in cart"));
  yield* call("agent_run_assess", {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation: "The fresh cart contains one giant anvil.",
    operationId: operation(),
    outcome: "working",
    outcomeComplete: true,
    sessionId: state.dry.id,
    view: "compact",
  });
  yield* call("agent_run_complete", {
    operationId: operation(),
    sessionId: state.dry.id,
  });
  process.stdout.write(`${state.teaching.viewUrl}\n`);
});
const takeover = Effect.gen(function* startTakeoverProof() {
  const state = yield* readState();
  const run = yield* call("agent_run_start", {
    clientName: "event-proof",
    clientVersion: "1",
    inputs: [],
    operationId: operation(),
    referencedSkills: [],
    requestedTask: "Inspect the disposable shop",
    url: state.url,
    view: "compact",
  });
  yield* save("state.json", { ...state, run });
  process.stdout.write(`${run.viewUrl}\n`);
});
const wait = Effect.gen(function* waitForUserAction() {
  const state = yield* readState();
  const target = waitTarget;
  const kind = waitKind;
  assert.ok(kind);
  const snapshot = yield* call("agent_session_get", {
    sessionId: state[target].id,
    view: "compact",
  });
  process.stdout.write(`waiting for ${kind}\n`);
  const result = yield* call("agent_session_get", {
    afterCursor: snapshot.eventCursor,
    sessionId: snapshot.id,
    waitMs: 45_000,
  });
  const event = result.events.find((item) => item.kind === kind);
  assert.ok(event, `Expected ${kind}, got ${JSON.stringify(result.events)}`);
  const receivedAfterEventMs = Date.now() - Date.parse(event.at);
  yield* save(`${kind}.json`, {
    entryPoint: "Workspace user action while MCP waits",
    receivedAfterEventMs,
    result,
  });
  const replay = yield* call("agent_session_get", {
    afterCursor: snapshot.eventCursor,
    sessionId: snapshot.id,
    waitMs: 0,
  });
  assert.deepEqual(replay.events.slice(0, result.events.length), result.events);
  process.stdout.write(`${kind} received in ${receivedAfterEventMs} ms\n`);
});
const finish = Effect.gen(function* finishProof() {
  const state = yield* readState();
  for (const key of [
    "variable-supplied",
    "teaching-started",
    "teaching-stopped",
    "flow-skill-verified",
    "takeover-returned",
  ]) {
    yield* io(() => readFile(path.join(artifacts, `${key}.json`), "utf-8"));
  }
  const catalog = path.join(directory, "state/catalog");
  const verified = yield* io(() =>
    readFile(
      path.join(catalog, "session-event-cart/references/verification.md"),
      "utf-8"
    )
  );
  assert.ok(verified.includes("- Verified:"));
  const retained = yield* io(() => readdir(path.join(catalog, ".recordings")));
  assert.ok(!retained.includes(state.recordingId));
  yield* save("catalog-reread.json", { retained, verified });
  const byTool = {};
  const files = yield* io(() => readdir(artifacts));
  for (const file of files.filter((name) => name.startsWith("call-"))) {
    const record = yield* io(async () =>
      JSON.parse(await readFile(path.join(artifacts, file), "utf-8"))
    );
    const entry = byTool[record.tool] ?? { bytes: 0, calls: 0 };
    byTool[record.tool] = {
      bytes: entry.bytes + record.bytes,
      calls: entry.calls + 1,
    };
  }
  yield* save("metrics.json", {
    baseline: {
      sessionGetBytes: 58_556,
      sessionGetCalls: 13,
      source: "reports/mcp-efficiency-2026-10-01.md",
    },
    byTool,
    comparison:
      "Each Workspace action uses one cursor wait, plus an intentional zero-wait replay assertion. No conversation report-back turn is needed. Average session-get bytes are compared with the ADR 0045 full-view task proof; the scenarios differ.",
    sessionGetAverageBytes:
      byTool.agent_session_get.bytes / byTool.agent_session_get.calls,
    sessionGetAverageReductionPercent:
      100 *
      (1 -
        byTool.agent_session_get.bytes /
          byTool.agent_session_get.calls /
          (58_556 / 13)),
  });
  yield* save("result.json", {
    entryPoint: "session-events-proof plus collaborative T3 Preview",
    ok: true,
  });
});
const retry = Effect.gen(function* retryDryRunProof() {
  const state = yield* readState();
  yield* call("agent_run_complete", {
    operationId: operation(),
    sessionId: state.dry.id,
  });
  yield* learn;
});
const phases = { finish, handoff, learn, pass, retry, start, takeover, wait };
assert.ok(
  phases[phase],
  "Choose start, handoff, learn, pass, takeover, wait, or finish."
);
await Effect.runPromise(
  io(() => mkdir(artifacts, { recursive: true })).pipe(
    Effect.andThen(phases[phase])
  )
);
