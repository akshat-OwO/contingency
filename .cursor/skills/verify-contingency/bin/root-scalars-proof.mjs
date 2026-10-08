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
  "../artifacts/root-scalars"
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
  const url = new URL("browser-check-scalars.html", instance.ecommerceUrl).href;
  const teaching = yield* call("agent_session_start", {
    activity: "teaching",
    clientName: "browser-check-proof",
    clientVersion: "1",
    name: "root-scalars-after",
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
  const instructions = timeline.entries.filter(
    (entry) => entry._tag === "instruction"
  );
  assert.equal(
    instructions.length,
    1,
    "One instruction retains the four scalar requirements and request context."
  );
  assert.ok(instructions[0].text.includes("root scalars"));
  const checks = instructions.flatMap((entry) =>
    (entry.attachments ?? []).flatMap((attachment) =>
      attachment.requirement === undefined ? [] : [attachment.requirement]
    )
  );
  assert.equal(checks.length, 4);
  for (const [index, expected] of ["ready", true, 42, null].entries()) {
    const check = checks[index];
    assert.equal(check.kind, "response");
    assert.equal(check.demonstrated, true);
    assert.deepEqual(check.expectation.itemPath, []);
    assert.deepEqual(check.expectation.predicates[0].path, []);
    assert.equal(check.expectation.predicates[0].operator, "equals");
    assert.equal(check.expectation.predicates[0].expected, expected);
  }
  const contexts = instructions.flatMap((entry) =>
    (entry.attachments ?? []).filter(
      (attachment) => attachment.requirement === undefined
    )
  );
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].candidate.demonstrated, false);
  const { url } = timeline.entries.find((entry) => entry._tag === "started");
  yield* save("timeline.json", timeline);
  yield* call("agent_flow_skill_save", {
    claimOperationId,
    files: [
      {
        content: `---\nname: ${flowSkillName}\ndescription: Submit once and require the four typed root scalar responses.\ninputs:\n---\n\n1. Click the Submit scalars button, arming Browser Checks ${checks.map((check) => check.id).join(" and ")} from [requirements](references/browser-checks.json). Done when: all four checks pass and Submitted 1 time(s) is visible.\n`,
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
  const failure = phase === "start-failure";
  const dry = yield* call("agent_flow_skill_dry_run_start", {
    inputs: [],
    operationId: operation(),
    recordingId: state.recordingId,
    url: failure ? `${state.url}?mismatch=1` : state.url,
    view: "compact",
  });
  yield* save("state.json", { ...state, failure, session: dry.session });
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
    (node) => node.role === "button" && node.name === "Submit scalars"
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
  assert.equal(result.browserCheckResults.length, 4);
  assert.equal(
    result.browserCheckResults.every(
      (check) => check.status === (state.failure ? "failed" : "passed")
    ),
    true
  );
  const replay = yield* call("agent_browser_act", params);
  assert.deepEqual(replay.browserCheckResults, result.browserCheckResults);
  const observed = yield* call("agent_browser_snapshot", {
    diagnostics: true,
    sessionId,
  });
  assert.ok(JSON.stringify(observed).includes("Submitted 1 time(s)"));
  const assessment = {
    evidence: [{ id: observed.snapshotId, kind: "snapshot" }],
    explanation: state.failure
      ? "Submit ran once but required effects did not occur; no dependent action was dispatched."
      : "Submit ran once; all four typed root scalars passed locally.",
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
  yield* save(state.failure ? "failed.json" : "passed.json", completed);
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
  yield* save(
    state.failure ? "persisted-failed.json" : "persisted-passed.json",
    persisted
  );
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
  "start-failure": launch,
  "start-pass": launch,
}[phase];
assert.ok(
  program,
  "Use start, handoff, learn, start-failure, start-pass, or finish."
);
await Effect.runPromise(
  io(() => mkdir(artifacts, { recursive: true })).pipe(Effect.andThen(program))
);
