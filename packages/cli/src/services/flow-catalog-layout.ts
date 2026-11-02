import path from "node:path";

import { FlowName } from "@contingency/protocol";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";

import { FLOW_FILE } from "./flow-package.ts";

export const RESERVED_FLOW_NAMES = new Set(["runs", "recordings", "flow.md"]);
const excluded = new Set(["runs", "recordings"]);
const skipDirectory = (name: string) =>
  name.startsWith(".") || excluded.has(name);
const isFlowName = Schema.is(FlowName);
const invalidFlowName = (name: string) =>
  RESERVED_FLOW_NAMES.has(name) || !isFlowName(name);
const invalid = (message: string) => ({
  _tag: "FlowCatalogError" as const,
  code: "agent_catalog_invalid" as const,
  message,
});

const isDraft = (
  directory: string,
  names: readonly string[],
  fs: FileSystem.FileSystem
) =>
  names.includes("recordings")
    ? fs
        .stat(path.join(directory, "recordings"))
        .pipe(Effect.map((stat) => stat.type === "Directory"))
    : Effect.succeed(false);

export type DiscoveredFlow =
  | {
      readonly kind: "flow";
      readonly content: string;
      readonly directory: string;
    }
  | { readonly kind: "draft"; readonly directory: string };

/** Enumerate once for listing, name lookup, and pre-save collision checks. */
export const discoverFlows = Effect.fnUntraced(function* discoverFlows(
  root: string,
  fs: FileSystem.FileSystem
) {
  const found = new Map<string, DiscoveredFlow>();
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
    const entry = path.join(directory, FLOW_FILE);
    const hasFlow =
      names.includes(FLOW_FILE) && (yield* fs.stat(entry)).type === "File";
    let owner = parentFlow;
    const hasDraft =
      directory !== root && (yield* isDraft(directory, names, fs));
    if (hasFlow || hasDraft) {
      if (parentFlow !== undefined) {
        return yield* Effect.fail(
          invalid(`Nested Flow ${directory} is inside Flow ${parentFlow}.`)
        );
      }
      const name = path.basename(directory);
      if (directory === root || invalidFlowName(name)) {
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
      found.set(
        name,
        hasFlow
          ? {
              content: yield* fs.readFileString(entry),
              directory,
              kind: "flow",
            }
          : { directory, kind: "draft" }
      );
      owner = directory;
    }
    for (const name of names.toReversed()) {
      if (skipDirectory(name)) {
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
    name: FlowName,
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
    const original = (yield* fs.exists(file))
      ? yield* fs.readFileString(file)
      : "";
    const previous = original
      .split(/\r?\n/u)
      .filter((line) => line !== ".recordings/" && line !== "agent-runs/")
      .join("\n");
    const lines = new Set(previous.split(/\r?\n/u));
    const missing = [
      "**/runs/",
      "**/recordings/",
      ".flow.lock",
      ".flow-*.tmp",
      ".flow-*.backup",
    ].filter((rule) => !lines.has(rule));
    if (missing.length > 0 || previous !== original) {
      yield* fs.writeFileString(
        file,
        `${previous}${previous.length > 0 && !previous.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`
      );
    }
  }
);
