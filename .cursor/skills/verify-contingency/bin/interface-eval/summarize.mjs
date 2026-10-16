#!/usr/bin/env node
// Recompute metrics from retained driver-owned and stdio evidence, without
// starting models or modifying the original run result.
/* oxlint-disable no-await-in-loop -- Each run is parsed and appended in chronological order. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { classify } from "./classify.mjs";
import { driverUsage } from "./drivers.mjs";
import { auditIsolation } from "./isolation.mjs";
import { artifacts, json, lines } from "./runtime.mjs";
import { claimsCartSuccess } from "./tasks.mjs";

const runs = [];
const names = await readdir(artifacts);
for (const name of names.toSorted()) {
  if (!/^\d{4}-/u.test(name) || name.endsWith("-overhead")) {
    continue;
  }
  const directory = path.join(artifacts, name);
  const original = JSON.parse(
    await readFile(path.join(directory, "result.json"), "utf-8")
  );
  let events;
  try {
    events = lines(
      await readFile(path.join(directory, "driver.jsonl"), "utf-8")
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      runs.push({ ...original, modelLaunched: false });
      continue;
    }
    throw error;
  }
  const usage = await driverUsage(original.model, events, directory);
  const journal = lines(
    await readFile(path.join(directory, "proxy.jsonl"), "utf-8")
  );
  const driverRejectedCalls = events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call" &&
        event.item?.error
    )
    .map((event) => ({ error: event.item.error, tool: event.item.tool }));
  const isolation = await auditIsolation(original.model, directory);
  json(path.join(directory, "isolation.json"), isolation);
  const check = { ...original.check };
  if (original.task === "cart") {
    check.claimsSuccess = claimsCartSuccess(original.finalText ?? "");
    check.complete = Boolean(
      check.skus?.length === 2 &&
      check.skus.includes("SKU ANVIL-001") &&
      check.skus.includes("SKU BENCH-002") &&
      check.reported &&
      check.claimsSuccess
    );
  }
  if (check.privacy?.literalAbsent === false) {
    check.complete = false;
  }
  const annotation = await readFile(
    path.join(directory, "annotation.json"),
    "utf-8"
  ).then(JSON.parse, (error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return {};
  });
  const result = {
    ...original,
    ...annotation,
    check,
    completion: Boolean(check.complete && original.exit?.[0] === 0),
    ...classify(journal, check, original.check?.timeline),
    driverRejectedCalls,
    isolation,
    modelLaunched: true,
    usage,
  };
  json(path.join(directory, "measurement.json"), result);
  runs.push(result);
}
json(path.join(artifacts, "summary.json"), runs);
await writeFile(
  path.join(artifacts, "runs.jsonl"),
  `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`
);
for (const run of runs.filter((row) => row.modelLaunched)) {
  process.stdout.write(
    `${JSON.stringify({ byRule: run.byRule, calls: run.calls, completion: run.completion, iface: run.iface, model: run.model, operations: run.operations, payloadBytes: run.payloadBytes, runId: run.runId, task: run.task, usage: run.usage, wallMs: run.wallMs })}\n`
  );
}
