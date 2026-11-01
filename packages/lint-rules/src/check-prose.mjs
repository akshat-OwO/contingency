#!/usr/bin/env node
/**
 * Fails when agent-facing Markdown holds a heavy prose block. The files are
 * the ones an MCP server hands an agent: docs topics, authoring resources,
 * and launch prompts.
 */
import { globSync, readFileSync } from "node:fs";

import { MAX_SENTENCES, MAX_WORDS, findHeavyBlocks } from "./prose.mjs";

export const AGENT_DOCS = [
  "packages/cli/docs/**/*.md",
  "packages/cli/onboarding/**/*.md",
  "packages/cli/resources/**/*.md",
];

const findings = globSync(AGENT_DOCS).flatMap((file) =>
  findHeavyBlocks(readFileSync(file, "utf-8")).map(
    ({ line, sentences, words }) =>
      `${file}:${line}: ${sentences} sentences, ${words} words`
  )
);

if (findings.length > 0) {
  console.error(
    `Heavy prose blocks (limit ${MAX_SENTENCES} sentences, ${MAX_WORDS} words). Split them into lists or shorter paragraphs:\n${findings.join("\n")}`
  );
  process.exitCode = 1;
}
