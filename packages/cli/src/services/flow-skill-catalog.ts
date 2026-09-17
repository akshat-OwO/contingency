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

import {
  flowSkillProcedureSteps,
  readFlowSkillFrontmatter,
  SKILL_FILE,
} from "./flow-skill-package.ts";
import type {
  FlowSkillEmulation,
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

/** The workspace's `.contingency` directory unless the environment names one. */
export const defaultCatalogRoot = (cwd: string = process.cwd()): string => {
  const configured = process.env.CONTINGENCY_CATALOG_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(cwd, ".contingency");
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
  readonly inputs: readonly string[];
  readonly name: FlowSkillName;
  readonly steps: readonly FlowSkillProcedureStep[];
  readonly title: string;
}

export interface FlowSkillCatalogService {
  readonly info: () => Effect.Effect<AgentCatalogInfo, FlowSkillCatalogError>;
  readonly list: () => Effect.Effect<FlowSkillList, FlowSkillCatalogError>;
  /** Read one saved package, or refuse when the directory holds no SKILL.md. */
  readonly read: (
    flowSkillName: FlowSkillName | string
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
  /** Notify process-owned companions when this catalog changes roots. */
  readonly onSelect?: (root: string) => void;
  readonly root: string;
}

/** Directories the Catalog Root owns that are never Flow Skills. */
const RESERVED = new Set([TEACHING_RECORDINGS_DIRECTORY, "agent-runs"]);

const isFlowSkillDirectory = (name: string): boolean =>
  !(name.startsWith(".") || RESERVED.has(name));

const makeCatalog = Effect.fnUntraced(function* makeFlowSkillCatalog(
  options: FlowSkillCatalogOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;
  // One MCP process selects one root at a time and the layers that follow it
  // read the choice synchronously, so the selection is a process-local value
  // rather than a Ref.
  let selected = path.resolve(options.root);

  const readPackage = Effect.fnUntraced(function* readFlowSkillPackage(
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
    const skillContent = yield* fileSystem
      .readFileString(skillFile)
      .pipe(Effect.mapError(ioError(`Could not read ${skillFile}`)));
    const referenceDirectory = path.join(directory, "references");
    const referencesPresent = yield* fileSystem
      .exists(referenceDirectory)
      .pipe(Effect.mapError(ioError(`Could not read ${referenceDirectory}`)));
    const referenceNames = referencesPresent
      ? yield* fileSystem
          .readDirectory(referenceDirectory, { recursive: true })
          .pipe(
            Effect.mapError(ioError(`Could not read ${referenceDirectory}`))
          )
      : [];
    const references = yield* Effect.forEach(
      referenceNames.filter((file) => file.endsWith(".md")),
      (file) =>
        fileSystem.readFileString(path.join(referenceDirectory, file)).pipe(
          Effect.map((content) => ({
            content,
            path: `references/${file.split(path.sep).join("/")}`,
          })),
          Effect.mapError(ioError(`Could not read references/${file}`))
        )
    );
    const frontmatter = readFlowSkillFrontmatter(skillContent);
    return {
      directory,
      emulation: frontmatter?.emulation,
      files: [{ content: skillContent, path: SKILL_FILE }, ...references],
      hosts: frontmatter?.hosts ?? [],
      inputs: frontmatter?.inputs ?? [],
      name: FlowSkillName.make(name),
      steps: flowSkillProcedureSteps(skillContent),
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
      const read = yield* Effect.result(readPackage(root, name));
      if (read._tag === "Failure") {
        continue;
      }
      found.push({
        description: read.success.title,
        inputs: read.success.inputs,
        name,
        path: read.success.directory,
        stepCount: read.success.steps.length,
      });
    }
    return found;
  });

  const list = Effect.fnUntraced(function* listFlowSkills() {
    return { catalogRoot: selected, flowSkills: yield* entries(selected) };
  });

  const service: FlowSkillCatalogService = {
    info: () =>
      list().pipe(
        Effect.map(({ catalogRoot, flowSkills }) => ({
          flowSkillCount: flowSkills.length,
          root: catalogRoot,
        }))
      ),
    list,
    read: Effect.fnUntraced(function* readSelectedFlowSkill(flowSkillName) {
      const root = selected;
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
