/**
 * Stages the CLI's packaged Markdown as Blume content. The source files stay
 * the single source for MCP resources, `docs_get`, npm, and GitHub; this copy
 * only adds what the site needs:
 *
 * - a `(NN-category)` group folder per sidebar group, which groups pages
 *   without adding a URL segment, so every page stays at `/docs/<page>`;
 * - a `meta.ts` per group, naming it and ordering its pages;
 * - frontmatter carrying the page description;
 * - the page's MCP resource URI under its title, in a copyable code block;
 * - site links for `contingency://` references to published pages.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DOC_CATEGORIES,
  DOC_SITE_RESOURCES,
  DOC_TOPICS,
  docUri,
} from "../../../packages/cli/src/services/doc-topics.ts";
import type { DocCategory } from "../../../packages/cli/src/services/doc-topics.ts";

const cliRoot = path.resolve(import.meta.dirname, "../../../packages/cli");
const contentRoot = path.resolve(import.meta.dirname, "../content");

interface StagedPage {
  readonly category: DocCategory;
  readonly description: string;
  readonly page: string;
  readonly source: string;
  readonly uri: string;
}

const pages: readonly StagedPage[] = [
  ...DOC_TOPICS.map((entry) => ({
    category: entry.category,
    description: entry.description,
    page: entry.topic,
    source: path.join(cliRoot, "docs", `${entry.topic}.md`),
    uri: docUri(entry.topic),
  })),
  ...DOC_SITE_RESOURCES.map((entry) => ({
    category: entry.category,
    description: entry.description,
    page: entry.page,
    source: path.join(cliRoot, "resources", entry.file),
    uri: entry.uri,
  })),
];

const pageByUri = new Map(pages.map((entry) => [entry.uri, entry.page]));

const groupFolder = (category: DocCategory) =>
  `(${String(DOC_CATEGORIES.indexOf(category) + 1).padStart(2, "0")}-${category.toLowerCase()})`;

/** `contingency://docs/run`, in backticks or bare, outside fenced code. */
const RESOURCE_REFERENCE =
  /`?(?<uri>contingency:\/\/[a-z-]+(?:\/[a-z-]+)+)`?/gu;

const linkReferences = (line: string) =>
  line.replaceAll(RESOURCE_REFERENCE, (match, uri: string) => {
    const page = pageByUri.get(uri);
    return page === undefined ? match : `[\`${uri}\`](/${page})`;
  });

const FENCE = /^\s*(?:```|~~~)/u;

const stagePage = (entry: StagedPage) => {
  const lines = readFileSync(entry.source, "utf-8").split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  if (titleIndex === -1) {
    throw new Error(`${entry.source} has no # title.`);
  }
  let fenced = false;
  const body = lines.map((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced || index === titleIndex ? line : linkReferences(line);
  });
  body.splice(titleIndex + 1, 0, "", "```text MCP resource", entry.uri, "```");
  return [
    "---",
    `description: ${JSON.stringify(entry.description)}`,
    "---",
    "",
    ...body,
  ].join("\n");
};

rmSync(contentRoot, { force: true, recursive: true });
for (const category of DOC_CATEGORIES) {
  const folder = path.join(contentRoot, groupFolder(category));
  mkdirSync(folder, { recursive: true });
  const members = pages.filter((entry) => entry.category === category);
  writeFileSync(
    path.join(folder, "meta.ts"),
    [
      'import { defineMeta } from "blume";',
      "",
      "export default defineMeta({",
      `  pages: ${JSON.stringify(members.map(({ page }) => page))},`,
      `  title: ${JSON.stringify(category)},`,
      "});",
      "",
    ].join("\n")
  );
  for (const entry of members) {
    writeFileSync(path.join(folder, `${entry.page}.md`), stagePage(entry));
  }
}
