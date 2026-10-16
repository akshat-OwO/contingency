/* oxlint-disable no-await-in-loop -- Read each driver log in order to preserve cumulative token event ordering. */
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { auditIsolation } from "./isolation.mjs";
import { json, lines } from "./runtime.mjs";

const proxy = path.join(import.meta.dirname, "proxy.mjs");
const driverEnv = () => {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
};
export const claudeUsage = (events) => {
  // Streaming can emit several assistant messages for one provider request.
  // Keep the latest usage for each request/message id rather than summing chunks.
  const requests = new Map();
  for (const event of events) {
    if (event.type === "assistant" && event.message?.usage) {
      requests.set(event.request_id ?? event.message.id, event.message.usage);
    }
  }
  const values = [...requests.values()];
  if (!values.length) {
    return { missing: true, source: "Claude assistant usage" };
  }
  const rows = values.map((value) => ({
    cacheWrite: value.cache_creation_input_tokens ?? 0,
    cached: value.cache_read_input_tokens ?? 0,
    input: value.input_tokens ?? 0,
    output: value.output_tokens ?? 0,
  }));
  return {
    cached: rows.reduce((sum, row) => sum + row.cached, 0),
    catalog: rows[0].input + rows[0].cached + rows[0].cacheWrite,
    input: rows.reduce(
      (sum, row) => sum + row.input + row.cached + row.cacheWrite,
      0
    ),
    output:
      events.findLast((event) => event.type === "result")?.usage
        ?.output_tokens ?? null,
    outputSource: "Claude result.usage.output_tokens, including thinking",
    peak: Math.max(
      ...rows.map((row) => row.input + row.cached + row.cacheWrite)
    ),
    requests: rows,
    source:
      "Claude assistant message.usage deduplicated by requestId/message.id",
  };
};
const files = async (directory) => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await files(file)));
      } else if (entry.name.endsWith(".jsonl")) {
        result.push(file);
      }
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};
export const codexUsage = async (directory, outputDirectory) => {
  const logs = await files(directory);
  const rows = [];
  const evidence = [];
  for (const file of logs) {
    let previous;
    for (const event of lines(await readFile(file, "utf-8"))) {
      if (event.type !== "event_msg" || event.payload?.type !== "token_count") {
        continue;
      }
      const { info } = event.payload;
      if (!info?.last_token_usage || !info.total_token_usage) {
        continue;
      }
      // Rate-limit events repeat the prior usage; the cumulative tuple identifies
      // newly accounted requests, including requests with identical last usage.
      const key = JSON.stringify(info.total_token_usage);
      if (key === previous) {
        continue;
      }
      previous = key;
      const value = info.last_token_usage;
      rows.push({
        cached: value.cached_input_tokens ?? 0,
        input: value.input_tokens,
        output: value.output_tokens,
        reasoning: value.reasoning_output_tokens ?? 0,
      });
      evidence.push(event);
    }
  }
  json(path.join(outputDirectory, "token-count-events.json"), evidence);
  if (!rows.length) {
    return {
      missing: true,
      source: "isolated CODEX_HOME/sessions token_count",
    };
  }
  // Codex input_tokens already includes cached_input_tokens, and output_tokens
  // includes reasoning_output_tokens. Do not count either subset twice.
  return {
    cached: rows.reduce((sum, row) => sum + row.cached, 0),
    catalog: rows[0].input,
    input: rows.reduce((sum, row) => sum + row.input, 0),
    output: rows.reduce((sum, row) => sum + row.output, 0),
    peak: Math.max(...rows.map((row) => row.input)),
    reasoning: rows.reduce((sum, row) => sum + row.reasoning, 0),
    requests: rows,
    source: "isolated CODEX_HOME/sessions token_count info.last_token_usage",
  };
};
export const drive = async ({
  model,
  directory,
  endpoint,
  prompt,
  resources,
  temporary,
}) => {
  const cwd = path.join(temporary, "empty-cwd");
  await mkdir(cwd);
  const env = driverEnv();
  let args;
  let executable;
  if (model === "haiku") {
    const config = path.join(directory, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          contingency: { args: [proxy, endpoint], command: process.execPath },
        },
      })
    );
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.ENABLE_TOOL_SEARCH = "false";
    executable = "claude";
    args = [
      "-p",
      "--model",
      "claude-haiku-5-5",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--tools",
      "",
      "--allowedTools",
      "mcp__contingency__*",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--debug-file",
      path.join(directory, "claude.debug.log"),
      prompt,
    ];
  } else {
    const home = path.join(directory, "codex-home");
    await mkdir(home);
    // Authentication is a symlink only. Never read or copy its contents.
    await symlink(
      path.join(homedir(), ".codex/auth.json"),
      path.join(home, "auth.json")
    );
    const config = `[mcp_servers.contingency]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([proxy, endpoint])}\nstartup_timeout_sec = 120\ntool_timeout_sec = 120\ndefault_tools_approval_mode = "approve"\n`;
    await writeFile(path.join(home, "config.toml"), config);
    env.CODEX_HOME = home;
    executable = "codex";
    args = [
      "exec",
      "--json",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="medium"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--enable",
      "skip_host_skill_discovery",
      "-c",
      "project_doc_max_bytes=0",
      prompt,
    ];
  }
  json(path.join(directory, "driver.json"), {
    args,
    auth:
      model === "sol"
        ? "symlink to ~/.codex/auth.json"
        : "existing Claude OAuth with restricted mode and memory disabled",
    cwd,
    environmentKeys: Object.keys(env),
    executable,
    prompt,
  });
  const child = resources.start(executable, args, { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
    appendFileSync(path.join(directory, "driver.jsonl"), data);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    appendFileSync(path.join(directory, "driver.stderr"), data);
  });
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
  let exit;
  try {
    exit = await once(child, "close");
  } finally {
    clearTimeout(timer);
  }
  const events = lines(stdout);
  const finalText =
    model === "haiku"
      ? (events.findLast((event) => event.type === "result")?.result ?? "")
      : events
          .filter(
            (event) =>
              event.type === "item.completed" &&
              event.item?.type === "agent_message"
          )
          .map((event) => event.item.text)
          .join("\n");
  const usage =
    model === "haiku"
      ? claudeUsage(events)
      : await codexUsage(
          path.join(directory, "codex-home/sessions"),
          directory
        );
  const init = events.find(
    (event) => event.type === "system" && event.subtype === "init"
  );
  const isolation = await auditIsolation(model, directory);
  json(path.join(directory, "isolation.json"), isolation);
  return { exit, finalText, init, isolation, stderr, usage };
};
