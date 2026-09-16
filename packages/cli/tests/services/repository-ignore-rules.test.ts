import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, test } from "vitest";

/**
 * The Catalog Root holds two kinds of file. A learned Flow Skill is shared
 * source and must reach a commit; Teaching Recordings, save scratch, and Agent
 * Flow state are sensitive or per-machine and must not. A blanket
 * `.contingency/` ignore loses the first kind silently, so the rules are
 * checked against sample paths rather than trusted by reading.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

const isIgnored = (candidate: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", candidate], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

test("tracks Flow Skill files under the Catalog Root", () => {
  for (const tracked of [
    ".contingency/set-delivery-area/SKILL.md",
    ".contingency/set-delivery-area/references/accessibility.md",
  ]) {
    expect(isIgnored(tracked), tracked).toBe(false);
  }
});

test("ignores Teaching Recordings, save scratch, and Agent Flow state", () => {
  for (const ignored of [
    ".contingency/.recordings/recording-1/manifest.json",
    ".contingency/.recordings/recording-1/trace.zip",
    ".contingency/.recordings/recording-1/recording.webm",
    ".contingency/.flow-skill.lock",
    ".contingency/.flow-skill-abc.tmp",
    ".contingency/.flow-skill-abc.backup",
    ".contingency/agent-flows/flow-1/manifest.json",
    ".contingency/agent-flow-catalog.json",
  ]) {
    expect(isIgnored(ignored), ignored).toBe(true);
  }
});
