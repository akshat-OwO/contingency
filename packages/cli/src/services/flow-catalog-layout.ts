import path from "node:path";

import { FlowSkillName } from "@contingency/protocol";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";

import { SKILL_FILE } from "./flow-skill-package.ts";

export const RESERVED_FLOW_NAMES = new Set(["runs", "recordings", "flow.md"]);
const excluded = new Set(["runs", "recordings"]);
const skipDirectory = (name: string, atRoot: boolean) =>
  name.startsWith(".") ||
  excluded.has(name) ||
  (atRoot && name === "agent-runs");
const isFlowName = Schema.is(FlowSkillName);
const invalid = (message: string) => ({
  _tag: "FlowSkillCatalogError" as const,
  code: "agent_catalog_invalid" as const,
  message,
});

/** Enumerate once for listing, name lookup, and pre-save collision checks. */
export const discoverFlows = Effect.fnUntraced(function* discoverFlows(
  root: string,
  fs: FileSystem.FileSystem
) {
  const found = new Map<
    string,
    { readonly content: string; readonly directory: string }
  >();
  if (!(yield* fs.exists(root))) {
    return found;
  }
  const realRoot = yield* fs.realPath(root);
  const pending: { directory: string; parentFlow: string | undefined }[] = [
    { directory: root, parentFlow: undefined },
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    const { directory, parentFlow } = next;
    const real = yield* fs.realPath(directory);
    const relative = path.relative(realRoot, real);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      visited.has(real)
    ) {
      continue;
    }
    visited.add(real);
    const names = (yield* fs.readDirectory(directory)).toSorted();
    const entry = path.join(directory, SKILL_FILE);
    const hasFlow =
      names.includes(SKILL_FILE) && (yield* fs.stat(entry)).type === "File";
    let owner = parentFlow;
    if (hasFlow) {
      if (parentFlow !== undefined) {
        return yield* Effect.fail(
          invalid(`Nested Flow ${directory} is inside Flow ${parentFlow}.`)
        );
      }
      const name = path.basename(directory);
      if (
        directory === root ||
        RESERVED_FLOW_NAMES.has(name) ||
        !isFlowName(name)
      ) {
        return yield* Effect.fail(
          invalid(`Invalid or reserved Flow name at ${directory}.`)
        );
      }
      const previous = found.get(name);
      if (previous !== undefined) {
        return yield* Effect.fail(
          invalid(
            `Duplicate Flow name "${name}" at ${previous.directory} and ${directory}.`
          )
        );
      }
      const content = yield* fs.readFileString(entry);
      found.set(name, { content, directory });
      owner = directory;
    }
    for (const name of names.toReversed()) {
      if (skipDirectory(name, directory === root)) {
        continue;
      }
      const child = path.join(directory, name);
      if ((yield* fs.stat(child)).type !== "Directory") {
        continue;
      }
      if (RESERVED_FLOW_NAMES.has(name)) {
        return yield* Effect.fail(
          invalid(`Reserved Group or Flow name at ${child}.`)
        );
      }
      pending.push({ directory: child, parentFlow: owner });
    }
  }
  return found;
});

/** Resolve identity at use time so regrouping never invalidates a saved reference. */
export const resolveFlowDirectory = Effect.fnUntraced(
  function* resolveFlowDirectory(
    root: string,
    name: FlowSkillName,
    fs: FileSystem.FileSystem
  ) {
    const flow = (yield* discoverFlows(root, fs)).get(name);
    if (flow === undefined) {
      return yield* Effect.fail(
        invalid(`${root} holds no Flow named "${name}".`)
      );
    }
    return flow.directory;
  }
);

/** Append missing managed rules, preserving the user's other ignore rules. */
export const maintainCatalogGitignore = Effect.fnUntraced(
  function* maintainCatalogGitignore(root: string, fs: FileSystem.FileSystem) {
    yield* fs.makeDirectory(root, { recursive: true });
    const file = path.join(root, ".gitignore");
    const previous = (yield* fs.exists(file))
      ? yield* fs.readFileString(file)
      : "";
    const lines = new Set(previous.split(/\r?\n/u));
    const missing = [
      "**/runs/",
      "**/recordings/",
      ".recordings/",
      "agent-runs/",
      ".flow-skill.lock",
      ".flow-skill-*.tmp",
      ".flow-skill-*.backup",
    ].filter((rule) => !lines.has(rule));
    if (missing.length > 0) {
      yield* fs.writeFileString(
        file,
        `${previous}${previous.length > 0 && !previous.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`
      );
    }
  }
);
