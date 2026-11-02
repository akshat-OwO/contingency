import path from "node:path";

import type { FlowSkillFile } from "@contingency/protocol";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";

import { FLOW_CONTRACT_FILES } from "./flow-skill-package.ts";

/** Read only reserved contracts whose targets stay inside the Flow. */
export const readFlowContractFiles = Effect.fnUntraced(function* readContracts(
  directory: string,
  fs: FileSystem
) {
  const real = yield* fs.realPath(directory);
  const files: FlowSkillFile[] = [];
  for (const name of FLOW_CONTRACT_FILES) {
    const file = path.join(directory, name);
    if (!(yield* fs.exists(file))) {
      continue;
    }
    const target = yield* fs.realPath(file);
    const relative = path.relative(real, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    files.push({ content: yield* fs.readFileString(file), path: name });
  }
  return files;
});
