#!/usr/bin/env node
// Pure metric regressions. No model, MCP, or browser is started.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cell } from "./cells.mjs";
import { classify, classifyTimeline } from "./classify.mjs";
import { claudeUsage, codexUsage } from "./drivers.mjs";
import { privacyCheck } from "./final-checks.mjs";
import { logMessage } from "./runtime.mjs";
import { claimsCartSuccess } from "./tasks.mjs";

assert.equal(
  claimsCartSuccess(
    "Both items are in the cart, and the session is still open."
  ),
  true
);
assert.equal(
  claimsCartSuccess(
    "Verified the cart contains exactly one anvil and one Workbench."
  ),
  true
);
assert.equal(
  claimsCartSuccess(
    "Inspected the cart. It contains exactly:\n\n- 1 Giant anvil\n- 1 Workbench"
  ),
  true
);
assert.equal(
  claimsCartSuccess("I could not add Giant anvil and Workbench to the cart."),
  false
);
const request = (name) => ({
  bytes: 10,
  direction: "request",
  message: { id: 1, method: "tools/call", params: { name } },
  owner: "model",
});
const answer = (body) => ({
  bytes: 20,
  direction: "answer",
  message: {
    id: 1,
    result: { content: [{ text: JSON.stringify(body), type: "text" }] },
  },
  owner: "model",
});
const nativeInvalid = {
  bytes: 20,
  direction: "answer",
  message: { error: { code: -32_602, message: "Invalid parameters" }, id: 1 },
  owner: "model",
};
assert.equal(
  classify([request("agent_browser_act"), nativeInvalid], {}).byRule[1],
  1
);
const rejected = {
  diagnostic: { message: "Invalid parameters" },
  receipts: [
    {
      message: "Invalid parameters",
      operation: "agent_browser_act",
      outcome: "failed",
    },
  ],
  status: "program_failed",
};
const invalidProgram = classify(
  [request("agent_code_execute"), answer(rejected)],
  { extraEffects: ["SKU ANVIL-001", "SKU ANVIL-001"] }
);
assert.equal(
  invalidProgram.byRule[1],
  1,
  "Do not count a receipt and its program diagnostic twice"
);
assert.equal(invalidProgram.byRule[2], 2, "Count each extra effect from state");
assert.equal(invalidProgram.operations, 1);
assert.equal(invalidProgram.payloadBytes, 30);
assert.equal(
  classify(
    [
      request("agent_code_execute"),
      answer({
        diagnostic: { message: "Unknown operation" },
        receipts: [],
        status: "program_failed",
      }),
    ],
    {}
  ).byRule[1],
  1
);
const usage = {
  cache_creation_input_tokens: 7,
  cache_read_input_tokens: 3,
  input_tokens: 2,
  output_tokens: 1,
};
const event = {
  message: { id: "one", usage },
  request_id: "one",
  type: "assistant",
};
const claude = claudeUsage([
  event,
  event,
  { type: "result", usage: { output_tokens: 42 } },
]);
assert.equal(claude.input, 12);
assert.equal(claude.peak, 12);
assert.equal(claude.output, 42);
assert.equal(claudeUsage([]).missing, true);
const privateMessage = {
  method: "tools/call",
  params: {
    arguments: { name: "PASSWORD", value: "private-sentinel" },
    name: "agent_variable_enter",
  },
};
assert.ok(
  !JSON.stringify(logMessage(privateMessage)).includes("private-sentinel")
);
assert.ok(
  !JSON.stringify(
    logMessage({
      params: {
        arguments: {
          code: 'const arbitrary = "private-sentinel"; return tools.agent_variable_enter({value: arbitrary});',
        },
      },
    })
  ).includes("private-sentinel")
);
assert.ok(
  JSON.stringify(
    logMessage({ result: { value: { id: "public-session" } } })
  ).includes("public-session"),
  "Keep program result values for classification"
);
const token = (total, last) => ({
  payload: {
    info: {
      last_token_usage: last,
      total_token_usage: { total_tokens: total },
    },
    type: "token_count",
  },
  type: "event_msg",
});
const directory = await mkdtemp(path.join(tmpdir(), "interface-eval-parser-"));
try {
  const sessions = path.join(directory, "sessions");
  await mkdir(sessions);
  const last = {
    cached_input_tokens: 6,
    input_tokens: 10,
    output_tokens: 4,
    reasoning_output_tokens: 2,
  };
  await writeFile(
    path.join(sessions, "run.jsonl"),
    [token(14, last), token(14, last), token(28, last)]
      .map(JSON.stringify)
      .join("\n")
  );
  const codex = await codexUsage(sessions, directory);
  assert.equal(
    codex.input,
    20,
    "Deduplicate repeated totals, retain identical requests with new totals"
  );
  assert.equal(codex.cached, 12);
  assert.equal(codex.peak, 10, "Cached input is already included");
  assert.equal(codex.output, 8, "Reasoning output is already included");
  await symlink(
    path.join(directory, "unreadable-auth-target"),
    path.join(directory, "auth.json")
  );
  const privacy = await privacyCheck({
    directory,
    scrub: String,
    state: { literalLeaks: [], secret: "synthetic-privacy-check-sentinel" },
  });
  assert.equal(
    privacy.literalAbsent,
    true,
    "Privacy audits skip authentication symlinks without following them"
  );
  const absent = await codexUsage(path.join(directory, "absent"), directory);
  assert.equal(absent.missing, true);
} finally {
  await rm(directory, { force: true, recursive: true });
}

const timedRequest = (id, name, at, args = {}) => ({
  ...request(name),
  at,
  message: { id, method: "tools/call", params: { arguments: args, name } },
});
const timedAnswer = (id, body, at) => ({
  ...answer(body),
  at,
  message: { ...answer(body).message, id },
});
const boundaryTimeline = [{ at: "02", kind: "refusal" }];
const refusalChoices = classifyTimeline(
  [
    timedRequest(1, "agent_browser_act", "03", {
      action: { ref: "e1", type: "click" },
    }),
    timedRequest(2, "agent_session_get", "04"),
    timedAnswer(2, { id: "session" }, "05"),
    timedRequest(3, "agent_browser_act", "06"),
  ],
  boundaryTimeline
);
assert.equal(refusalChoices.filter((choice) => choice.rule === 3).length, 1);
const staleChoices = classifyTimeline(
  [
    timedRequest(1, "agent_browser_snapshot", "00"),
    timedAnswer(1, { nodes: [{ ref: "e1" }], snapshotId: "old" }, "01"),
    timedRequest(2, "agent_session_get", "03"),
    timedAnswer(2, {}, "04"),
    timedRequest(3, "agent_browser_act", "05", {
      action: { ref: "e1", type: "click" },
    }),
    timedRequest(4, "agent_browser_snapshot", "06"),
    timedAnswer(4, { nodes: [{ ref: "e1" }], snapshotId: "fresh" }, "07"),
    timedRequest(5, "agent_browser_act", "08", {
      action: { ref: "e1", type: "click" },
    }),
  ],
  [{ at: "02", kind: "return-control" }]
);
assert.equal(
  staleChoices.filter((choice) => choice.rule === 4).length,
  1,
  "A fresh Snapshot can renew a reference"
);
const program = (readFirst) =>
  classifyTimeline(
    [
      timedRequest(1, "agent_code_execute", "03", {
        code: `return await tools.agent_browser_act({action:{ref:"e1",type:"click"}});`,
      }),
      timedAnswer(
        1,
        {
          receipts: [
            ...(readFirst
              ? [{ operation: "agent_session_get", outcome: "succeeded" }]
              : []),
            { operation: "agent_browser_act", outcome: "succeeded" },
            ...(readFirst
              ? []
              : [{ operation: "agent_session_get", outcome: "succeeded" }]),
          ],
        },
        "04"
      ),
    ],
    boundaryTimeline
  );
assert.equal(program(true).filter((choice) => choice.rule === 3).length, 0);
assert.equal(
  program(false).filter((choice) => choice.rule === 3).length,
  1,
  "A later read does not excuse an earlier action"
);
assert.equal(
  classifyTimeline(
    [
      timedRequest(1, "agent_session_get", "03"),
      { ...nativeInvalid, at: "04" },
      timedRequest(2, "agent_browser_act", "05"),
    ],
    boundaryTimeline
  ).filter((choice) => choice.rule === 3).length,
  1,
  "A rejected reread does not clear intervention"
);

const singleStale = classifyTimeline(
  [
    timedRequest(1, "agent_browser_snapshot", "00"),
    timedAnswer(1, { nodes: [{ ref: "e1" }], snapshotId: "old" }, "01"),
    timedRequest(2, "agent_code_execute", "03", {
      code: 'await tools.agent_session_get({sessionId:"s"}); return await tools.agent_browser_act({action:{ref:"e1",type:"click"}});',
    }),
    timedAnswer(
      2,
      {
        receipts: [
          { operation: "agent_session_get", outcome: "succeeded", sequence: 1 },
          { operation: "agent_browser_act", outcome: "succeeded", sequence: 2 },
        ],
      },
      "04"
    ),
  ],
  [{ at: "02", kind: "return-control" }]
);
assert.equal(singleStale.filter((choice) => choice.rule === 3).length, 0);
assert.equal(
  singleStale.filter((choice) => choice.rule === 4).length,
  1,
  "A session read does not renew a stale Snapshot target"
);

const referenceProgram = (code, receipts) =>
  classifyTimeline(
    [
      timedRequest(1, "agent_browser_snapshot", "00"),
      timedAnswer(1, { nodes: [{ ref: "e1" }], snapshotId: "old" }, "01"),
      timedRequest(2, "agent_code_execute", "03", { code }),
      timedAnswer(2, { receipts }, "04"),
    ],
    [
      { at: "02", kind: "return-control" },
      { at: "02.1", kind: "stale-notice" },
    ]
  );
const actionReceipt = {
  operation: "agent_browser_act",
  outcome: "succeeded",
  sequence: 1,
};
assert.equal(
  referenceProgram(
    'const target = "e1"; const action = {type:"click",ref:target}; return tools.agent_browser_act({action});',
    [actionReceipt]
  ).filter((choice) => choice.rule === 4).length,
  1,
  "Constant aliases and repeated staleness notices retain stale targets"
);
assert.equal(
  referenceProgram(
    'const s = await tools.agent_browser_snapshot({}); const ref = s.nodes.find(n => n.name === "Cart").ref; return tools.agent_browser_act({action:{type:"click",ref}});',
    [
      {
        operation: "agent_browser_snapshot",
        outcome: "succeeded",
        sequence: 1,
      },
      actionReceipt,
    ]
  ).filter((choice) => choice.rule === 4 || choice.reviewRequired).length,
  0,
  "A target derived from a new Snapshot is fresh"
);
assert.equal(
  referenceProgram(
    "return tools.agent_browser_act({action: unresolvedAction});",
    [actionReceipt]
  ).filter((choice) => choice.reviewRequired).length,
  1,
  "Unresolved targets require review instead of a silent zero"
);
const readReceipt = {
  operation: "agent_session_get",
  outcome: "succeeded",
  sequence: 1,
};
const actReceipt = (sequence) => ({ ...actionReceipt, sequence });
const deadBranch = referenceProgram(
  'await tools.agent_session_get({}); if (false) { await tools.agent_browser_act({action:{type:"click",ref:"e99"}}); } return tools.agent_browser_act({action:{type:"click",ref:"e1"}});',
  [readReceipt, actReceipt(2)]
);
assert.equal(
  deadBranch.filter((choice) => choice.rule === 4).length,
  0,
  "An unexecuted call never lends its target to an executed receipt"
);
assert.equal(
  deadBranch.filter((choice) => choice.reviewRequired).length,
  1,
  "A receipt behind a branch needs review instead of a confident count"
);
assert.equal(
  referenceProgram(
    'await tools.agent_session_get({}); for (const ref of ["e2", "e1"]) { await tools.agent_browser_act({action:{type:"click",ref}}); }',
    [readReceipt, actReceipt(2), actReceipt(3)]
  ).filter((choice) => choice.reviewRequired).length,
  2,
  "A call repeated by a loop needs review for every receipt it made"
);
assert.equal(
  referenceProgram(
    'await tools.agent_session_get({}); await tools.agent_browser_act({action:{type:"click",ref:"e2"}}); return tools.agent_browser_act({action:{type:"click",ref:"e1"}});',
    [readReceipt, actReceipt(2), actReceipt(3)]
  ).filter((choice) => choice.rule === 4).length,
  1,
  "Straight-line calls still match their receipts in order"
);
for (const [code, label] of [
  [
    'await tools.agent_session_get({}); let ref = "e1"; if (false) { ref = "e99"; } return tools.agent_browser_act({action:{type:"click",ref}});',
    "A binding written in a branch",
  ],
  [
    'await tools.agent_session_get({}); const action = {type:"click",ref:"e99"}; action.ref = "e1"; return tools.agent_browser_act({action});',
    "A property write",
  ],
  [
    'await tools.agent_session_get({}); const action = {type:"click",ref:"e99"}; const alias = action; alias.ref = "e1"; return tools.agent_browser_act({action});',
    "A property write through an alias",
  ],
  [
    'await tools.agent_session_get({}); const action = {type:"click",ref:"e99"}; Object.assign(action, {ref:"e1"}); return tools.agent_browser_act({action});',
    "Object.assign",
  ],
  [
    'await tools.agent_session_get({}); const s = await tools.agent_browser_snapshot({}); s.nodes[0].ref = "e1"; return tools.agent_browser_act({action:{type:"click",ref:s.nodes[0].ref}});',
    "A write into fresh Snapshot data",
  ],
]) {
  const choices = referenceProgram(code, [readReceipt, actReceipt(2)]);
  assert.equal(
    choices.filter((choice) => choice.reviewRequired).length,
    1,
    `${label} makes the target unresolved`
  );
  assert.equal(choices.filter((choice) => choice.rule === 4).length, 0);
}
const joined = classify(
  [
    timedRequest(1, "agent_browser_snapshot", "00"),
    timedAnswer(1, { nodes: [{ ref: "e1" }], snapshotId: "old" }, "01"),
    timedRequest(2, "agent_code_execute", "03", {
      code: 'await tools.agent_session_get({}); const ref = ["e1"].join(""); return tools.agent_browser_act({action:{type:"click",ref}});',
    }),
    timedAnswer(2, { receipts: [readReceipt, actReceipt(2)] }, "04"),
  ],
  {},
  [{ at: "02", kind: "return-control" }]
);
assert.equal(joined.classificationValid, false);
const unresolvedCell = cell([
  {
    ...joined,
    completion: true,
    runId: "joined",
    usage: { input: 1, output: 1, peak: 1 },
    wallMs: 1,
  },
]);
assert.deepEqual(
  unresolvedCell.unresolvedClassifications,
  ["joined"],
  "Aggregation reports an unresolved run rather than counting it as zero"
);
process.stdout.write("Interface evaluation metric checks passed\n");
