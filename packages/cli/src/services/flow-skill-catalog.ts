import path from "node:path";

import { FlowSkillName } from "@contingency/protocol";
import type {
  AgentCatalogInfo,
  FlowSkillFile,
  FlowSkillList,
  FlowSkillListEntry,
  OperationId,
} from "@contingency/protocol";
import { Context, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Mutable } from "effect/Types";

import { DEMO_SITE_ID, isDemoHosts } from "./demo-site.ts";
import {
  flowSkillProcedureSteps,
  readFlowSkillFrontmatter,
  SKILL_FILE,
} from "./flow-skill-package.ts";
import type {
  FlowSkillEmulation,
  FlowSkillInput,
  FlowSkillProcedureStep,
} from "./flow-skill-package.ts";
import { TEACHING_RECORDINGS_DIRECTORY } from "./teaching-recording-store.ts";

/**
 * The Catalog Root and the Flow Skill packages inside it.
 *
 * A Flow Skill is a directory of markdown: `SKILL.md` plus optional
 * `references/`. There are no revisions, no heads, and no evidence packages
 * beside it, because the Flow Skill is the single reusable format
 * ([ADR 0039](../../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
 * This service only selects the root and reads what is already on disk;
 * writing a package belongs to Teaching Recording learning, which is the only
 * path that may produce one.
 */

/** The directory a project's Catalog Root lives in. */
export const CATALOG_DIRECTORY = ".contingency";

/** The workspace's `.contingency` directory unless the environment names one. */
export const defaultCatalogRoot = (cwd: string = process.cwd()): string => {
  const configured = process.env.CONTINGENCY_CATALOG_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(cwd, CATALOG_DIRECTORY);
};

export interface FlowSkillCatalogError {
  readonly _tag: "FlowSkillCatalogError";
  readonly code:
    | "agent_catalog_invalid"
    | "agent_catalog_io"
    | "flow_skill_not_found";
  readonly message: string;
}

const catalogError = (
  code: FlowSkillCatalogError["code"],
  message: string
): FlowSkillCatalogError => ({ _tag: "FlowSkillCatalogError", code, message });

const ioError = (context: string) => (cause: PlatformError) =>
  catalogError("agent_catalog_io", `${context}: ${cause.message}`);

/** One Flow Skill package as it sits on disk. */
export interface FlowSkillPackage {
  readonly directory: string;
  /** The Emulation the journey was demonstrated under, when the package has one. */
  readonly emulation: FlowSkillEmulation | undefined;
  readonly files: readonly FlowSkillFile[];
  /** The demonstrated host ceiling. Empty for a package saved before stamping. */
  readonly hosts: readonly string[];
  readonly inputs: readonly FlowSkillInput[];
  readonly name: FlowSkillName;
  readonly steps: readonly FlowSkillProcedureStep[];
  readonly title: string;
}

export interface FlowSkillCatalogService {
  readonly info: () => Effect.Effect<AgentCatalogInfo, FlowSkillCatalogError>;
  readonly list: () => Effect.Effect<FlowSkillList, FlowSkillCatalogError>;
  /**
   * Read one saved package, or refuse when the directory holds no SKILL.md.
   * `root` names a Catalog Root other than the selected one, such as the root
   * that holds the Teaching Recording a package was learned from.
   */
  readonly read: (
    flowSkillName: FlowSkillName | string,
    root?: string
  ) => Effect.Effect<FlowSkillPackage, FlowSkillCatalogError>;
  readonly root: () => string;
  readonly select: (
    root: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentCatalogInfo, FlowSkillCatalogError>;
}

export const FlowSkillCatalog = Context.Service<FlowSkillCatalogService>(
  "@contingency/FlowSkillCatalog"
);

export interface FlowSkillCatalogOptions {
  /**
   * Set when `root` is the original onboarding directory's catalog because no
   * usable current project directory was available (ADR 0049). It is
   * reported until another root is selected.
   */
  readonly fallback?: AgentCatalogInfo["fallback"];
  /** Notify process-owned companions when this catalog changes roots. */
  readonly onSelect?: (root: string) => void;
  readonly root: string;
}

/** Directories the Catalog Root owns that are never Flow Skills. */
const RESERVED = new Set([TEACHING_RECORDINGS_DIRECTORY, "agent-runs"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or undefined when its bytes are not UTF-8 text. */
const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** Whether a Catalog Root entry could be a Flow Skill directory. */
export const isFlowSkillDirectory = (name: string): boolean =>
  !(name.startsWith(".") || RESERVED.has(name));

const makeCatalog = Effect.fnUntraced(function* makeFlowSkillCatalog(
  options: FlowSkillCatalogOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;
  // One MCP process selects one root at a time and the layers that follow it
  // read the choice synchronously, so the selection is a process-local value
  // rather than a Ref.
  let selected = path.resolve(options.root);

  const readSkillFile = Effect.fnUntraced(function* readFlowSkillFile(
    root: string,
    name: string
  ) {
    const directory = path.join(root, name);
    const skillFile = path.join(directory, SKILL_FILE);
    const present = yield* fileSystem
      .exists(skillFile)
      .pipe(Effect.mapError(ioError(`Could not read ${skillFile}`)));
    if (!present) {
      return yield* Effect.fail(
        catalogError(
          "flow_skill_not_found",
          `${directory} holds no ${SKILL_FILE}, so it is not a Flow Skill.`
        )
      );
    }
    const content = yield* fileSystem
      .readFileString(skillFile)
      .pipe(Effect.mapError(ioError(`Could not read ${skillFile}`)));
    return { content, directory };
  });

  /**
   * Every text file under `references/`, the same set Teaching Recording
   * learning saves. A file that is not UTF-8 text, such as an image a user
   * committed beside the package, is not part of the package an agent reads.
   */
  const readReferences = Effect.fnUntraced(function* readReferenceFiles(
    directory: string
  ) {
    const referenceDirectory = path.join(directory, "references");
    const present = yield* fileSystem
      .exists(referenceDirectory)
      .pipe(Effect.mapError(ioError(`Could not read ${referenceDirectory}`)));
    if (!present) {
      return [];
    }
    const names = yield* fileSystem
      .readDirectory(referenceDirectory, { recursive: true })
      .pipe(Effect.mapError(ioError(`Could not read ${referenceDirectory}`)));
    const references: FlowSkillFile[] = [];
    for (const file of names.toSorted()) {
      const filePath = path.join(referenceDirectory, file);
      const context = `Could not read references/${file}`;
      const info = yield* fileSystem
        .stat(filePath)
        .pipe(Effect.mapError(ioError(context)));
      if (info.type !== "File") {
        continue;
      }
      const bytes = yield* fileSystem
        .readFile(filePath)
        .pipe(Effect.mapError(ioError(context)));
      const content = decodeText(bytes);
      if (content !== undefined) {
        references.push({
          content,
          path: `references/${file.split(path.sep).join("/")}`,
        });
      }
    }
    return references;
  });

  const readPackage = Effect.fnUntraced(function* readFlowSkillPackage(
    root: string,
    name: string
  ) {
    const skill = yield* readSkillFile(root, name);
    const references = yield* readReferences(skill.directory);
    const frontmatter = readFlowSkillFrontmatter(skill.content);
    return {
      directory: skill.directory,
      emulation: frontmatter?.emulation,
      files: [{ content: skill.content, path: SKILL_FILE }, ...references],
      hosts: frontmatter?.hosts ?? [],
      inputs: frontmatter?.inputs ?? [],
      name: FlowSkillName.make(name),
      steps: flowSkillProcedureSteps(skill.content),
      title: frontmatter?.description ?? name,
    } satisfies FlowSkillPackage;
  });

  const entries = Effect.fnUntraced(function* readFlowSkillEntries(
    root: string
  ) {
    const present = yield* fileSystem
      .exists(root)
      .pipe(Effect.mapError(ioError(`Could not read ${root}`)));
    if (!present) {
      return [];
    }
    const names = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.mapError(ioError(`Could not read ${root}`)));
    const found: FlowSkillListEntry[] = [];
    for (const name of names.filter(isFlowSkillDirectory).toSorted()) {
      // A directory without a SKILL.md is somebody else's, not a broken Flow
      // Skill, so it is skipped rather than reported.
      // A listing needs only SKILL.md, so references are not read here.
      const read = yield* Effect.result(readSkillFile(root, name));
      if (read._tag === "Failure") {
        continue;
      }
      const frontmatter = readFlowSkillFrontmatter(read.success.content);
      const entry: Mutable<FlowSkillListEntry> = {
        description: frontmatter?.description ?? name,
        inputs: (frontmatter?.inputs ?? []).map(
          ({ description, name: inputName }) =>
            description === undefined
              ? { name: inputName }
              : { description, name: inputName }
        ),
        name,
        stepCount: flowSkillProcedureSteps(read.success.content).length,
      };
      if (isDemoHosts(frontmatter?.hosts ?? [])) {
        entry.demo = DEMO_SITE_ID;
      }
      found.push(entry);
    }
    return found;
  });

  const list = Effect.fnUntraced(function* listFlowSkills() {
    return { flowSkills: yield* entries(selected) };
  });

  const service: FlowSkillCatalogService = {
    info: () =>
      entries(selected).pipe(
        Effect.map((flowSkills) => {
          const info: Mutable<AgentCatalogInfo> = {
            flowSkillCount: flowSkills.length,
            root: selected,
          };
          // The fallback describes the root this process started with; a
          // root the agent selects since is the agent's own choice.
          if (
            options.fallback !== undefined &&
            selected === path.resolve(options.root)
          ) {
            info.fallback = options.fallback;
          }
          return info;
        })
      ),
    list,
    read: Effect.fnUntraced(function* readFlowSkill(
      flowSkillName,
      root = selected
    ) {
      const name = String(flowSkillName);
      if (!isFlowSkillDirectory(name) || name.includes(path.sep)) {
        return yield* Effect.fail(
          catalogError(
            "flow_skill_not_found",
            `"${name}" is not a Flow Skill directory inside ${root}.`
          )
        );
      }
      return yield* readPackage(root, name);
    }),
    root: () => selected,
    select: Effect.fnUntraced(function* selectCatalogRoot(root) {
      if (!path.isAbsolute(root)) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            `The Catalog Root must be an absolute directory path, not "${root}".`
          )
        );
      }
      const resolved = path.resolve(root);
      yield* fileSystem
        .makeDirectory(resolved, { recursive: true })
        .pipe(Effect.mapError(ioError(`Could not create ${resolved}`)));
      selected = resolved;
      options.onSelect?.(resolved);
      return {
        flowSkillCount: (yield* entries(resolved)).length,
        root: resolved,
      };
    }),
  };
  return service;
});

export const makeFlowSkillCatalogLayer = (
  options: FlowSkillCatalogOptions
): Layer.Layer<FlowSkillCatalogService, never, FileSystem.FileSystem> =>
  Layer.effect(FlowSkillCatalog, makeCatalog(options));
