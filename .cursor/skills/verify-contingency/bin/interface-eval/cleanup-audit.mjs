#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- Audit each retained run and port in deterministic order. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { artifacts, json, lines, Predicate } from "./runtime.mjs";

const since = process.argv[2] ?? "0000";
const rows = execFileSync("ps", ["-axo", "pid=,lstart=,command="], {
  encoding: "utf-8",
})
  .trim()
  .split("\n")
  .map((line) => {
    const match = line
      .trim()
      .match(/^(?<pid>\d+)\s+(?<started>.{24})\s+(?<command>.*)$/u);
    return { ...match.groups, pid: Number(match.groups.pid) };
  });
const runs = [];
const owned = new Map();
const interpreters = new Set();
const ports = new Set();
const surviving = [];
const missing = (error) => {
  if (error.code !== "ENOENT") {
    throw error;
  }
  return null;
};
const collectInterpreter = (value) => {
  if (!Predicate.isObject(value)) {
    return;
  }
  if (value.process?.pid && value.process.exit) {
    interpreters.add(value.process.pid);
  }
  for (const item of Object.values(value)) {
    if (Predicate.isString(item) && item.startsWith("{")) {
      try {
        collectInterpreter(JSON.parse(item));
      } catch {
        continue;
      }
    } else {
      collectInterpreter(item);
    }
  }
};
const names = await readdir(artifacts, { withFileTypes: true });
for (const name of names
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted()) {
  if (name < since && !name.startsWith("round-4-context-check")) {
    continue;
  }
  const directory = path.join(artifacts, name);
  const cleanup = await readFile(
    path.join(directory, "cleanup.json"),
    "utf-8"
  ).then(JSON.parse, missing);
  if (!cleanup) {
    continue;
  }
  runs.push(name);
  assert.equal(cleanup.survivors.length, 0, name);
  assert.equal(cleanup.listeners.length, 0, name);
  for (const process of cleanup.processes) {
    owned.set(process.pid, process);
    if (
      rows.some(
        (row) => row.pid === process.pid && row.started === process.started
      )
    ) {
      surviving.push(process);
    }
  }
  for (const { port } of cleanup.ports) {
    ports.add(port);
  }
  const proxy = await readFile(
    path.join(directory, "proxy.jsonl"),
    "utf-8"
  ).catch(missing);
  for (const entry of lines(proxy ?? "")) {
    collectInterpreter(entry.message);
  }
  const condition = await readFile(
    path.join(directory, "conditions.json"),
    "utf-8"
  ).then(JSON.parse, missing);
  if (condition) {
    assert.equal(
      await stat(condition.temporary).then(
        () => true,
        () => false
      ),
      false,
      `Temporary state survived: ${name}`
    );
    assert.equal(
      await stat(path.join(directory, "codex-home/auth.json")).then(
        () => true,
        () => false
      ),
      false,
      `Authentication symlink survived: ${name}`
    );
  }
}
const liveInterpreters = rows.filter((row) => interpreters.has(row.pid));
const listeners = [];
for (const port of ports) {
  try {
    listeners.push(
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf-8",
      })
    );
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }
  }
}
const result = {
  at: new Date().toISOString(),
  interpreterPids: [...interpreters],
  listeners,
  liveInterpreters,
  ports: [...ports],
  runs,
  surviving,
  trackedProcesses: owned.size,
};
json(path.join(artifacts, "round-4-cleanup-audit.json"), result);
assert.equal(
  surviving.length + liveInterpreters.length + listeners.length,
  0,
  "Owned resource audit failed; inspect identities before taking any action"
);
process.stdout.write(
  `${JSON.stringify({ interpreters: interpreters.size, listeners: listeners.length, runs: runs.length, surviving: surviving.length, trackedProcesses: owned.size })}\n`
);
