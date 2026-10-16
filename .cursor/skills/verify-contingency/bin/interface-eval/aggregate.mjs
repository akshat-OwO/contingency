#!/usr/bin/env node
// Per-cell aggregates of the #461 matrix from summarized runs. Run
// summarize.mjs first; this reads its measurement.json files and nothing else.
/* oxlint-disable no-await-in-loop -- Runs are read in chronological order. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { cell } from "./cells.mjs";
import { artifacts, json } from "./runtime.mjs";

// Harness revisions the matrix ran on. Earlier runs were smoke.
const matrixCommits = new Set(["bb775c94", "cade5e72"]);
// The first Haiku Android pair ran one cleanup-only commit earlier.
const androidCommits = new Set([...matrixCommits, "f81cff1e"]);
const optional = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
};
const runs = [];
const excluded = [];
const names = await readdir(artifacts);
for (const name of names.filter((entry) => /^\d{4}-/u.test(entry)).toSorted()) {
  const directory = path.join(artifacts, name);
  const [measurement, conditions] = await Promise.all([
    optional(path.join(directory, "measurement.json")),
    optional(path.join(directory, "conditions.json")),
  ]);
  if (
    !measurement?.modelLaunched ||
    !conditions ||
    measurement.task === "calibration"
  ) {
    continue;
  }
  const commit = conditions.commit.slice(0, 8);
  const commits =
    measurement.task === "android" ? androidCommits : matrixCommits;
  if (!commits.has(commit)) {
    continue;
  }
  const annotation =
    (await optional(path.join(directory, "annotation.json"))) ?? {};
  const run = { ...measurement, ...annotation, commit, runId: name };
  if (run.excluded || run.harnessDefect) {
    excluded.push({
      reason: run.excludedReason ?? run.harnessDefectReason ?? "harness defect",
      runId: name,
    });
    continue;
  }
  runs.push(run);
}

const cells = new Map();
for (const run of runs) {
  const key = `${run.model}/${run.task}/${run.iface}`;
  cells.set(key, [...(cells.get(key) ?? []), run]);
}
const aggregate = Object.fromEntries(
  [...cells]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, list]) => [key, cell(list)])
);
const unresolved = Object.values(aggregate).flatMap(
  (value) => value.unresolvedClassifications
);
// The benefit gate is complete only once every counted choice is known.
json(path.join(artifacts, "aggregate.json"), {
  aggregate,
  benefitGateComplete: unresolved.length === 0,
  excluded,
  unresolved,
});
const rows = Object.entries(aggregate).map(([key, value]) => {
  const [model, task, iface] = key.split("/");
  const incorrect = Object.values(value.incorrect).reduce((a, b) => a + b, 0);
  return [
    model,
    task,
    iface,
    `${value.completed}/${value.runs}`,
    value.input?.median ?? "missing",
    value.peak?.median ?? "missing",
    value.output?.median ?? "missing",
    incorrect,
    Math.round(value.wallMs?.median / 1000),
  ].join("\t");
});
console.log(
  [
    "model",
    "task",
    "iface",
    "done",
    "input",
    "peak",
    "output",
    "wrong",
    "wall s",
  ].join("\t")
);
console.log(rows.join("\n"));
console.log(`excluded ${excluded.length}`);
console.log(
  unresolved.length
    ? `UNRESOLVED classifications, benefit gate incomplete: ${unresolved.join(", ")}`
    : "unresolved classifications 0"
);
