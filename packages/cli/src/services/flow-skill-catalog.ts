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
  discoverFlows,
  maintainCatalogGitignore,
} from "./flow-catalog-layout.ts";
import { readFlowContractFiles } from "./flow-contract-files.ts";
import { isFlowDocumentArea, isSupportingDocument } from "./flow-documents.ts";
import {
  flowSkillProcedureSteps,
  isVerifiedFlowSkill,
  readFlowSkillFrontmatter,
  SKILL_FILE,
} from "./flow-skill-package.ts";
import type {
  FlowSkillEmulation,
  FlowSkillInput,
  FlowSkillProcedureStep,
} from "./flow-skill-package.ts";
import { browserRequirements } from "./platform-requirements.ts";
import type { SavedPlatformRequirements } from "./platform-requirements.ts";
import { TEACHING_RECORDINGS_DIRECTORY } from "./teaching-recording-store.ts";

/**
 * The Catalog Root and the Flow Skill packages inside it.
 *
 * A Flow holds `flow.md`, supporting markdown at any depth, and local
 * evidence in `recordings/` and `runs/`. The Flow is the reusable format
 * ([ADR 0039](../../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
 * This service only selects the root and reads what is already on disk;
 * writing a package belongs to Teaching Recording learning, which is the only
 * path that may produce one.
 */

/** The directory a project's Catalog Root lives in. */
export const CATALOG_DIRECTORY = "contingency";
export const GLOBAL_CATALOG_DIRECTORY = ".contingency";

/** The workspace's `contingency` directory unless the environment names one. */
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
  readonly runtime?: SavedPlatformRequirements;
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
   * Read one saved package, or refuse when the directory holds no flow.md.
   * `root` names a Catalog Root other than the selected one, such as the root
   * that holds the Teaching Recording a package was learned from.
   */
  readonly read: (
    flowSkillName: FlowSkillName | string,
    root?: string
  ) => Effect.Effect<FlowSkillPackage, FlowSkillCatalogError>;
  readonly readDocument: (
    flowSkillName: string,
    documentPath: string,
    root?: string
  ) => Effect.Effect<FlowSkillFile, FlowSkillCatalogError>;
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
const RESERVED = new Set([TEACHING_RECORDINGS_DIRECTORY, "runs"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or undefined when its bytes are not UTF-8 text. */
const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** Whether `target` is `directory` itself or somewhere beneath it. */
export const isInside = (directory: string, target: string): boolean => {
  const relative = path.relative(directory, target);
  return !(relative.startsWith("..") || path.isAbsolute(relative));
};

/** Whether a Catalog Root entry could be a Flow Skill directory. */
export const isFlowSkillDirectory = (name: string): boolean =>
  !(
    name.startsWith(".") ||
    RESERVED.has(name) ||
    ["runs", "recordings", "flow.md"].includes(name)
  );

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
    const flows = yield* discoverFlows(root, fileSystem).pipe(
      Effect.mapError((cause) =>
        cause._tag === "FlowSkillCatalogError"
          ? cause
          : ioError(`Could not read ${root}`)(cause)
      )
    );
    const flow = flows.get(name);
    if (flow === undefined || flow.kind === "draft") {
      return yield* Effect.fail(
        catalogError(
          "flow_skill_not_found",
          `${root} holds no Flow named "${name}".`
        )
      );
    }
    return flow;
  });

  const readReferences = Effect.fnUntraced(function* readSupportingDocuments(
    directory: string
  ) {
    const realRoot = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.mapError(ioError("Could not resolve Flow")));
    const pending = [""];
    const visited = new Set<string>();
    const documents: FlowSkillFile[] = [];
    while (pending.length > 0) {
      const parent = pending.pop() ?? "";
      const real = yield* fileSystem
        .realPath(path.join(directory, parent))
        .pipe(Effect.mapError(ioError("Could not resolve Flow documents")));
      const relative = path.relative(realRoot, real).split(path.sep).join("/");
      if (
        !isInside(realRoot, real) ||
        (relative !== "" && !isFlowDocumentArea(relative)) ||
        visited.has(real)
      ) {
        continue;
      }
      visited.add(real);
      const names = yield* fileSystem
        .readDirectory(path.join(directory, parent))
        .pipe(Effect.mapError(ioError("Could not list Flow documents")));
      for (const name of names.toSorted()) {
        const file = parent === "" ? name : `${parent}/${name}`;
        if (!isFlowDocumentArea(file)) {
          continue;
        }
        const absolute = path.join(directory, file);
        const target = yield* fileSystem
          .realPath(absolute)
          .pipe(Effect.mapError(ioError(`Could not resolve ${file}`)));
        const targetRelative = path
          .relative(realRoot, target)
          .split(path.sep)
          .join("/");
        if (
          !isInside(realRoot, target) ||
          !isFlowDocumentArea(targetRelative)
        ) {
          continue;
        }
        const info = yield* fileSystem
          .stat(absolute)
          .pipe(Effect.mapError(ioError(`Could not inspect ${file}`)));
        if (info.type === "Directory") {
          pending.push(file);
        } else if (info.type === "File" && isSupportingDocument(file)) {
          const content = decodeText(
            yield* fileSystem
              .readFile(absolute)
              .pipe(Effect.mapError(ioError(`Could not read ${file}`)))
          );
          if (content !== undefined) {
            documents.push({ content, path: file });
          }
        }
      }
    }
    return documents.toSorted((a, b) => a.path.localeCompare(b.path));
  });

  const readPackage = Effect.fnUntraced(function* readFlowSkillPackage(
    root: string,
    name: string
  ) {
    const skill = yield* readSkillFile(root, name);
    const references = yield* readReferences(skill.directory);
    references.push(
      ...(yield* readFlowContractFiles(skill.directory, fileSystem).pipe(
        Effect.mapError(
          ioError(`Could not read contracts in ${skill.directory}`)
        )
      ))
    );
    const frontmatter = readFlowSkillFrontmatter(skill.content);
    return {
      directory: skill.directory,
      emulation: frontmatter?.emulation,
      files: [{ content: skill.content, path: SKILL_FILE }, ...references],
      hosts: frontmatter?.hosts ?? [],
      inputs: frontmatter?.inputs ?? [],
      name: FlowSkillName.make(name),
      runtime: frontmatter?.runtime ?? {
        diagnostics: [],
        requirements: browserRequirements,
      },
      steps: flowSkillProcedureSteps(skill.content),
      title: frontmatter?.description ?? name,
    } satisfies FlowSkillPackage;
  });

  const entries = Effect.fnUntraced(function* readFlowSkillEntries(
    root: string
  ) {
    const flows = yield* discoverFlows(root, fileSystem).pipe(
      Effect.mapError((cause) =>
        cause._tag === "FlowSkillCatalogError"
          ? cause
          : ioError(`Could not read ${root}`)(cause)
      )
    );
    const found: FlowSkillListEntry[] = [];
    for (const [name, flow] of [...flows].toSorted(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (flow.kind === "draft") {
        continue;
      }
      const frontmatter = readFlowSkillFrontmatter(flow.content);
      const contracts = yield* readFlowContractFiles(
        flow.directory,
        fileSystem
      ).pipe(
        Effect.mapError(
          ioError(`Could not read contracts in ${flow.directory}`)
        )
      );
      const entry: Mutable<FlowSkillListEntry> = {
        description: frontmatter?.description ?? name,
        inputs: (frontmatter?.inputs ?? []).map(
          ({ description, name: inputName }) =>
            description === undefined
              ? { name: inputName }
              : { description, name: inputName }
        ),
        name,
        stepCount: flowSkillProcedureSteps(flow.content).length,
        verified: isVerifiedFlowSkill(
          [{ content: flow.content, path: SKILL_FILE }, ...contracts],
          frontmatter?.runtime.requirements.platform
        ),
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
    readDocument: Effect.fnUntraced(function* readDocument(
      name,
      documentPath,
      root = selected
    ) {
      if (!isSupportingDocument(documentPath)) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            `Not a supporting document path: ${documentPath}`
          )
        );
      }
      const skill = yield* readPackage(root, name);
      const file = skill.files.find((entry) => entry.path === documentPath);
      if (file === undefined) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            `Supporting document ${documentPath} was not found in Flow ${name}.`
          )
        );
      }
      return file;
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
      yield* maintainCatalogGitignore(resolved, fileSystem).pipe(
        Effect.mapError(ioError(`Could not maintain ${resolved}/.gitignore`))
      );
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
