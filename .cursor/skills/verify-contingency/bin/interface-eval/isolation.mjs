/* oxlint-disable no-await-in-loop -- Audit only the run's own files, in directory order. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { lines } from "./runtime.mjs";

const sessionFiles = async (directory) => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await sessionFiles(file)));
    } else if (entry.name.endsWith(".jsonl")) {
      result.push(file);
    }
  }
  return result;
};
const auditClaude = async (directory, emptyTemporaryCwd) => {
  const events = lines(
    await readFile(path.join(directory, "driver.jsonl"), "utf-8")
  );
  const init = events.find(
    (event) => event.type === "system" && event.subtype === "init"
  );
  const debug = await readFile(
    path.join(directory, "claude.debug.log"),
    "utf-8"
  );
  const onlyContingencyTools =
    Boolean(init?.tools?.length) &&
    init.tools.every((tool) => tool.startsWith("mcp__contingency__"));
  const onlyContingencyServer =
    init?.mcp_servers?.length === 1 &&
    init.mcp_servers[0].name === "contingency";
  const projectMemoryOff = debug.includes("project memory is off");
  return {
    contextValid:
      emptyTemporaryCwd &&
      onlyContingencyTools &&
      onlyContingencyServer &&
      projectMemoryOff &&
      init.skills?.length === 0,
    emptyTemporaryCwd,
    init,
    onlyContingencyServer,
    onlyContingencyTools,
    projectMemoryOff,
    source: "driver system/init, debug memory marker and launch manifest",
  };
};
const auditOpencode = async (directory, emptyTemporaryCwd) => {
  const config = JSON.parse(
    await readFile(
      path.join(directory, "opencode-config/opencode/opencode.json"),
      "utf-8"
    )
  );
  const events = lines(
    await readFile(path.join(directory, "driver.jsonl"), "utf-8")
  );
  // OpenCode prints no init event, so check the tools the model actually used.
  const toolsUsed = [
    ...new Set(
      events
        .filter((event) => event.type === "tool_use")
        .map((event) => event.part?.tool)
    ),
  ];
  const onlyContingencyServer =
    JSON.stringify(Object.keys(config.mcp)) === '["contingency"]';
  const onlyContingencyTools = toolsUsed.every((tool) =>
    String(tool).startsWith("contingency_")
  );
  return {
    // Built-in tools are advertised but denied; a denied attempt is a client
    // refusal, not context. Only another server or a real cwd invalidates.
    builtinToolsAdvertised: true,
    contextValid: emptyTemporaryCwd && onlyContingencyServer,
    emptyTemporaryCwd,
    onlyContingencyServer,
    onlyContingencyTools,
    source:
      "private OpenCode config, tool_use events and launch manifest; the system prompt is not exported",
    toolsUsed,
  };
};
export const auditIsolation = async (model, directory) => {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "driver.json"), "utf-8")
  );
  const emptyTemporaryCwd =
    manifest.cwd.includes("contingency-interface-eval-") &&
    manifest.cwd.endsWith("/empty-cwd");
  if (model === "haiku") {
    return auditClaude(directory, emptyTemporaryCwd);
  }
  if (model !== "sol") {
    return auditOpencode(directory, emptyTemporaryCwd);
  }
  const instructions = [];
  for (const file of await sessionFiles(
    path.join(directory, "codex-home/sessions")
  )) {
    for (const event of lines(await readFile(file, "utf-8"))) {
      if (
        event.type === "response_item" &&
        event.payload?.type === "message" &&
        ["developer", "user"].includes(event.payload.role)
      ) {
        instructions.push({
          role: event.payload.role,
          text:
            event.payload.content?.map((item) => item.text).join("\n") ?? "",
        });
      }
    }
  }
  const hostSkillCatalog = instructions.filter(
    (item) =>
      item.role === "developer" && /<skills_instructions>/u.test(item.text)
  );
  return {
    contextValid: emptyTemporaryCwd && hostSkillCatalog.length === 0,
    emptyTemporaryCwd,
    hostSkillCatalogLoaded: hostSkillCatalog.length > 0,
    instructionRoles: instructions.map((item) => item.role),
    source:
      "run-owned Codex session response_item messages and launch manifest",
    unavoidableBuiltinDeveloperMessages: instructions
      .filter(
        (item) => item.role === "developer" && !hostSkillCatalog.includes(item)
      )
      .map((item) => item.text.slice(0, 90)),
  };
};
