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
