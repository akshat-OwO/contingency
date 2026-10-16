#!/usr/bin/env node
// Pure metric regressions. No model, MCP, or browser is started.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classify } from "./classify.mjs";
import { claudeUsage, codexUsage } from "./drivers.mjs";
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
  const absent = await codexUsage(path.join(directory, "absent"), directory);
  assert.equal(absent.missing, true);
} finally {
  await rm(directory, { force: true, recursive: true });
}
process.stdout.write("Interface evaluation metric checks passed\n");
