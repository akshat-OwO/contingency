// Inspect Codex's assembled input without making a model request.
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { artifacts, json, Resources } from "./runtime.mjs";

const directory = path.join(artifacts, `round-4-context-check-${Date.now()}`);
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(
  path.join(tmpdir(), "contingency-interface-eval-context-")
);
const resources = new Resources(directory);
try {
  await mkdir(path.join(temporary, "home"));
  const args = [
    "--enable",
    "skip_host_skill_discovery",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "skills.include_instructions=false",
    "debug",
    "prompt-input",
    "ready",
  ];
  json(path.join(directory, "command.json"), { args, modelLaunched: false });
  const child = resources.start("codex", args, {
    cwd: temporary,
    env: {
      CODEX_HOME: path.join(temporary, "home"),
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const guard = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const exit = await once(child, "close");
  clearTimeout(guard);
  const result = {
    contextValid: exit[0] === 0 && !stdout.includes("<skills_instructions>"),
    exit,
    modelLaunched: false,
    stderr,
    stdout,
  };
  json(path.join(directory, "result.json"), result);
  process.stdout.write(
    `${JSON.stringify({ ...result, stdout: stdout.slice(0, 150) })}\n`
  );
} finally {
  await resources.cleanup();
  await rm(temporary, { force: true, recursive: true });
}
