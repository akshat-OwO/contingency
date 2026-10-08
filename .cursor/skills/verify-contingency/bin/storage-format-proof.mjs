// Drive saved Browser Checks through the public MCP boundary of an isolated instance.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  "../artifacts/storage-format"
);
assert.ok(process.env.CONTINGENCY_VERIFY_DIR);
const [phase] = process.argv.slice(2);
const io = (action) => Effect.tryPromise(action);
const operation = () => `browser-check-proof-${crypto.randomUUID()}`;
const save = (name, value) =>
  io(() =>
    writeFile(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`)
  );
const call = (tool, params, refusal = false) =>
  io(async () => {
    let stdout;
    let exitCode = 0;
    try {
      ({ stdout } = await execute(
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
      ));
    } catch (error) {
      if (error.code !== 2) {
        throw error;
      }
      ({ stdout, code: exitCode } = error);
    }
    assert.equal(exitCode, refusal ? 2 : 0, stdout);
    if (refusal) {
      await writeFile(
        path.join(artifacts, `refusal-${Date.now()}.txt`),
        stdout
      );
      return stdout;
    }
    const value = JSON.parse(stdout);
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes("fixture-private-token"));
    assert.ok(!serialized.includes("fixture-private-cookie"));
    await writeFile(
      path.join(artifacts, `call-${Date.now()}-${crypto.randomUUID()}.json`),
      JSON.stringify({ params, tool, value }, null, 2)
    );
    return value;
  });
const expectedChecks = [
  { change: "changed", format: "json", kind: "local" },
  { change: "changed", format: "json", kind: "session" },
  { change: "changed", format: "raw", kind: "local" },
  { change: "changed", format: "raw", kind: "session" },
];
const outcomes = {
  "start-malformed": ["inconclusive", "inconclusive", "passed", "passed"],
  "start-mismatch": ["failed", "failed", "failed", "passed"],
  "start-pass": ["passed", "passed", "passed", "passed"],
};
const skill = (flowSkillName, checks) =>
  `---\nname: ${flowSkillName}\ndescription: Save the order once and require its stored local and session state.\ninputs:\n---\n\n1. Click the Save order button, arming Browser Checks ${checks.map((check) => check.id).join(" and ")} from [requirements](references/browser-checks.json). Done when: all four checks pass and Saved 1 time(s) is visible.\n`;
const readState = () =>
  io(async () =>
    JSON.parse(await readFile(path.join(artifacts, "state.json"), "utf-8"))
  );
const start = Effect.gen(function* startTeaching() {
  const instance = yield* io(async () =>
    JSON.parse(
      await readFile(
        path.join(process.env.CONTINGENCY_VERIFY_DIR, "instance.json"),
        "utf-8"
      )
    )
  );
  const url = new URL("browser-check-storage.html", instance.ecommerceUrl).href;
  const teaching = yield* call("agent_session_start", {
    activity: "teaching",
    clientName: "browser-check-proof",
    clientVersion: "1",
    name: "storage-format",
    operationId: operation(),
    url,
    view: "compact",
    viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
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
const learn = Effect.gen(function* learnRequirements() {
  const state = yield* readState();
  const { recordingId } = (yield* call("agent_session_get", {
    sessionId: state.teaching.id,
    view: "compact",
  })).teaching;
  const claimOperationId = operation();
  const claimed = yield* call("agent_teaching_recording_claim", {
    action: "take",
    operationId: claimOperationId,
    recordingId,
  });
  const { flowSkillName } = claimed.claim;
  const timeline = yield* call("agent_teaching_timeline_get", {
    claimOperationId,
    recordingId,
  });
  const checks = timeline.entries
    .filter((entry) => entry._tag === "instruction")
    .flatMap((entry) =>
      (entry.attachments ?? []).flatMap((attachment) =>
        attachment.requirement === undefined ? [] : [attachment.requirement]
      )
    );
  assert.deepEqual(
    checks.map(({ kind, format, change }) => ({ change, format, kind })),
    expectedChecks
  );
  for (const check of checks) {
    assert.equal(check.name, "order");
    assert.equal(check.demonstrated, false);
    if (check.format === "raw") {
      assert.deepEqual(check.expectation.itemPath, []);
      assert.ok(
        check.expectation.predicates.every(
          (predicate) => predicate.path.length === 0
        )
      );
    }
  }
  assert.deepEqual(checks[1].expectation, {
    itemPath: ["order", "items", "*"],
    predicates: checks[1].expectation.predicates,
  });
  assert.deepEqual(
    checks[1].expectation.predicates.map(({ expected, path: field }) => ({
      expected,
      field,
    })),
    [
      { expected: "b", field: ["sku"] },
      { expected: 1, field: ["qty"] },
    ]
  );
  const { url } = timeline.entries.find((entry) => entry._tag === "started");
  yield* save("timeline.json", timeline);
  const rawWithPath = checks.map((check, index) =>
    index === 0 ? { ...check, format: "raw" } : check
  );
  const refusal = yield* call(
    "agent_flow_skill_save",
    {
      claimOperationId,
      files: [
        { content: skill(flowSkillName, checks), path: "SKILL.md" },
        {
          content: JSON.stringify({
            requirements: rawWithPath,
            schemaVersion: 1,
          }),
          path: "references/browser-checks.json",
        },
      ],
      operationId: operation(),
      recordingId,
    },
    true
  );
  assert.ok(refusal.includes("Raw storage values are strings"), refusal);
  yield* call("agent_flow_skill_save", {
    claimOperationId,
    files: [
      {
        content: skill(flowSkillName, checks),
        path: "SKILL.md",
      },
      {
        content: JSON.stringify(
          { requirements: checks, schemaVersion: 1 },
          null,
          2
        ),
        path: "references/browser-checks.json",
      },
    ],
    operationId: operation(),
    recordingId,
  });
  const saved = yield* io(async () =>
    JSON.parse(
      await readFile(
        path.join(
          process.env.CONTINGENCY_VERIFY_DIR,
          "state/catalog",
          flowSkillName,
          "references/browser-checks.json"
        ),
        "utf-8"
      )
    )
  );
  assert.deepEqual(saved.requirements, checks);
  yield* save("persisted-checks.json", saved);
  yield* save("state.json", {
    checks,
    claimOperationId,
    flowSkillName,
    recordingId,
    url,
  });
});
const launch = Effect.gen(function* launchDryRun() {
  const state = yield* readState();
  const failure = phase !== "start-pass";
  const mode = phase.slice("start-".length);
  const dry = yield* call("agent_flow_skill_dry_run_start", {
    inputs: [],
    operationId: operation(),
    recordingId: state.recordingId,
    url: failure ? `${state.url}?mode=${mode}` : state.url,
    view: "compact",
  });
  yield* save("state.json", {
    ...state,
    expected: outcomes[phase],
    failure,
    mode,
    session: dry.session,
  });
  process.stdout.write(`${dry.session.viewUrl}\n`);
});
const finish = Effect.gen(function* finishDryRun() {
  const state = yield* readState();
  const sessionId = state.session.id;
  const snapshot = yield* call("agent_browser_snapshot", {
    diagnostics: true,
    format: "structured",
    sessionId,
  });
  const button = snapshot.nodes.find(
    (node) => node.role === "button" && node.name === "Save order"
  );
  assert.ok(button);
  const params = {
    action: { ref: button.ref, type: "click" },
    checkIds: state.checks.map((check) => ({
      flowSkillName: state.flowSkillName,
      id: check.id,
    })),
    format: "structured",
    operationId: operation(),
    sessionId,
  };
  const result = yield* call("agent_browser_act", params);
  assert.deepEqual(
    result.browserCheckResults.map((check) => check.status),
    state.expected
  );
  assert.ok(!JSON.stringify(result).includes('"status":"ready"'));
  const replay = yield* call("agent_browser_act", params);
  assert.deepEqual(replay.browserCheckResults, result.browserCheckResults);
  const observed = yield* call("agent_browser_snapshot", {
    diagnostics: true,
    sessionId,
  });
  assert.ok(JSON.stringify(observed).includes("Saved 1 time(s)"));
  const assessment = {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation: state.failure
      ? "Submit ran once but required effects did not occur; no dependent action was dispatched."
      : "Save order ran once; raw and JSON storage checks passed for both areas.",
    operationId: operation(),
    outcome: "working",
    outcomeComplete: true,
    sessionId,
    view: "compact",
  };
  if (state.failure) {
    yield* call("agent_run_assess", assessment, true);
    yield* call(
      "agent_browser_act",
      { ...params, checkIds: undefined, operationId: operation() },
      true
    );
    yield* call("agent_run_assess", {
      ...assessment,
      operationId: operation(),
      outcome: "not-working",
    });
  } else {
    yield* call("agent_run_assess", assessment);
  }
  const completed = yield* call("agent_run_complete", {
    operationId: operation(),
    sessionId,
  });
  yield* save(`${state.mode}.json`, completed);
  const persisted = yield* io(async () =>
    JSON.parse(
      await readFile(
        path.join(
          process.env.CONTINGENCY_VERIFY_DIR,
          "state/catalog/.recordings",
          state.recordingId,
          "dry-run/summary.json"
        ),
        "utf-8"
      )
    )
  );
  assert.deepEqual(
    persisted.browserCheckResults,
    completed.browserCheckResults
  );
  assert.deepEqual(persisted.browserChecks, completed.browserChecks);
  yield* save(`persisted-${state.mode}.json`, persisted);
  const recording = yield* call("agent_teaching_recordings_list", {
    recordingId: state.recordingId,
  });
  assert.equal(
    recording.recordings[0].lifecycle,
    state.failure ? "dry-run-failed" : "dry-run-passed"
  );
});
const program = {
  finish,
  handoff,
  learn,
  start,
  "start-malformed": launch,
  "start-mismatch": launch,
  "start-pass": launch,
}[phase];
assert.ok(
  program,
  "Use start, handoff, learn, start-malformed, start-mismatch, start-pass, or finish."
);
await Effect.runPromise(
  io(() => mkdir(artifacts, { recursive: true })).pipe(Effect.andThen(program))
);
