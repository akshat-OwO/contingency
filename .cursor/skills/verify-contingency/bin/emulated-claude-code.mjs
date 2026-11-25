#!/usr/bin/env node
// A real Claude Code against an emulated model (ADR 0090, #824). Builds the
// CLI, then runs the emulated harness integration test `--runs` times (one by
// default) and keeps each run's output, endpoint record included, under
// artifacts/emulated-claude-code/. The test skips when `claude` is not on PATH,
// so this command refuses to start without it.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const artifacts = path.resolve(
  import.meta.dirname,
  "../artifacts/emulated-claude-code"
);
const { values } = parseArgs({
  options: { runs: { default: "1", type: "string" } },
});
const runs = Math.trunc(Number(values.runs));
if (!Number.isInteger(runs) || runs < 1) {
  process.stderr.write("Pass --runs as a positive integer.\n");
  process.exit(2);
}
if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stderr.write("Install Claude Code first: `claude` is not on PATH.\n");
  process.exit(2);
}
const build = spawnSync(
  "vp",
  ["exec", "turbo", "run", "build", "--filter=@contingencyhq/cli"],
  { cwd: repoRoot, stdio: "inherit" }
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
mkdirSync(artifacts, { recursive: true });
const results = [];
for (let run = 1; run <= runs; run += 1) {
  const started = Date.now();
  const test = spawnSync(
    "vp",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.integration.config.ts",
      "tests/integration/claude-code-emulated.integration.test.ts",
    ],
    { cwd: path.join(repoRoot, "packages/cli"), encoding: "utf-8" }
  );
  const output = `${test.stdout}${test.stderr}`;
  writeFileSync(path.join(artifacts, `run-${run}.log`), output);
  const passed = test.status === 0 && output.includes("1 passed");
  results.push({ durationMs: Date.now() - started, passed, run });
  process.stdout.write(`run ${run}: ${passed ? "passed" : "failed"}\n`);
}
const summary = {
  passed: results.filter((result) => result.passed).length,
  results,
  runs,
};
writeFileSync(
  path.join(artifacts, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(summary.passed === runs ? 0 : 1);
