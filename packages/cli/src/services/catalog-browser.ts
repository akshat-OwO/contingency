import os from "node:os";
import path from "node:path";

import {
  AgentRunSummary,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import type {
  FlowSkillName,
  CatalogBrowseResult,
  CatalogFlowSkillEntry,
  CatalogFlowSkillResult,
  CatalogRecordingEntry,
  CatalogRootScope,
  CatalogRootView,
  CatalogRunEntry,
} from "@contingency/protocol";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Mutable } from "effect/Types";

import { AGENT_RUNS_DIRECTORY } from "./agent-run-store.ts";
import { DEMO_SITE_ID, isDemoHosts } from "./demo-site.ts";
import {
  CATALOG_DIRECTORY,
  FlowSkillCatalog,
  isFlowSkillDirectory,
} from "./flow-skill-catalog.ts";
import type {
  FlowSkillCatalogService,
  FlowSkillPackage,
} from "./flow-skill-catalog.ts";
import { isVerifiedFlowSkill } from "./requested-flow-skills.ts";
import { TEACHING_RECORDINGS_DIRECTORY } from "./teaching-recording-store.ts";

/**
 * The Workspace's read-only view of Catalog Roots for the Skills drawer.
 *
 * It lists the Flow Skills, persisted Runs, and Teaching Recordings of the
 * process's own Catalog Root, and of the user's `~/.contingency` when that is
 * a different directory. It reads manifests and Run Summaries, never videos,
 * Traces, or keyframes, and it writes nothing. The global root is a Workspace
 * convenience only: no MCP tool reads it, so an agent still never searches a
 * user-global catalog (ADR 0051).
 */

export interface CatalogBrowserError {
  readonly _tag: "CatalogBrowserError";
  readonly code: "catalog_io" | "flow_skill_not_found";
  readonly message: string;
}

const browserError = (
  code: CatalogBrowserError["code"],
  message: string
): CatalogBrowserError => ({ _tag: "CatalogBrowserError", code, message });

const ioError = (context: string) => (cause: PlatformError) =>
  browserError("catalog_io", `${context}: ${cause.message}`);

export interface CatalogBrowserService {
  readonly browse: () => Effect.Effect<
    CatalogBrowseResult,
    CatalogBrowserError
  >;
  readonly flowSkill: (
    scope: CatalogRootScope,
    name: FlowSkillName
  ) => Effect.Effect<CatalogFlowSkillResult, CatalogBrowserError>;
}

export const CatalogBrowser = Context.Service<CatalogBrowserService>(
  "@contingency/CatalogBrowser"
);

export interface CatalogBrowserOptions {
  /** The user-global Catalog Root, or `undefined` to list the local one only. */
  readonly globalRoot: string | undefined;
  /** Read on every call, so selecting another Catalog Root takes effect. */
  readonly localRoot: () => string;
}

/** `~/.contingency`, unless the environment names another directory. */
export const defaultGlobalCatalogRoot = (): string => {
  const configured = process.env.CONTINGENCY_GLOBAL_CATALOG_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), CATALOG_DIRECTORY);
};

const SUMMARY_FILE = "summary.json";
const MANIFEST_FILE = "manifest.json";
const DRY_RUN_DIRECTORY = "dry-run";
/** Enough to keep a large catalog responsive without exhausting descriptors. */
const READ_CONCURRENCY = 8;

const decodeSummary = Schema.decodeEffect(
  Schema.fromJsonString(AgentRunSummary)
);
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(TeachingRecordingManifest)
);

/** A Run Summary reduced to its list entry, for every Summary version. */
export const catalogRunEntry = (summary: AgentRunSummary): CatalogRunEntry => {
  if (summary.schemaVersion === 3) {
    return {
      assessment: summary.assessment?.outcome ?? null,
      endedAt: summary.endedAt,
      flowSkillNames: summary.referencedSkills.map(
        (skill) => skill.flowSkillName
      ),
      kind: summary.purpose.kind,
      outcome: summary.outcome,
      recordingId:
        summary.purpose.kind === "dry-run" ? summary.purpose.recordingId : null,
      runId: summary.runId,
      startedAt: summary.startedAt,
      title: summary.title,
    };
  }
  return {
    assessment: null,
    endedAt: summary.endedAt,
    flowSkillNames: summary.schemaVersion === 2 ? [summary.flowSkillName] : [],
    kind: "legacy",
    outcome: summary.outcome,
    recordingId: null,
    runId: summary.runId,
    startedAt: summary.startedAt,
    title: summary.title,
  };
};

export const catalogRecordingEntry = (
  manifest: TeachingRecordingManifest
): CatalogRecordingEntry => ({
  cleanup: manifest.cleanup._tag,
  createdAt: manifest.createdAt,
  flowSkillName: manifest.flowSkillName,
  keyframeCount: manifest.artifacts.filter(
    (artifact) => artifact.kind === "keyframe"
  ).length,
  phase: manifest.lifecycle._tag,
  recordingId: manifest.recordingId,
});

export const catalogFlowSkillEntry = (
  skill: FlowSkillPackage
): CatalogFlowSkillEntry => {
  const entry: Mutable<CatalogFlowSkillEntry> = {
    description: skill.title,
    hosts: skill.hosts,
    name: skill.name,
    stepCount: skill.steps.length,
    verified: isVerifiedFlowSkill(skill.files),
  };
  if (isDemoHosts(skill.hosts)) {
    entry.demo = DEMO_SITE_ID;
  }
  return entry;
};

type Read<A> =
  | { readonly _tag: "absent" }
  | { readonly _tag: "read"; readonly value: A }
  | { readonly _tag: "unreadable" };

const readValues = <A>(entries: readonly Read<A>[]): readonly A[] =>
  entries.flatMap((entry) => (entry._tag === "read" ? [entry.value] : []));

const newestFirst = <A extends { readonly startedAt: string }>(
  entries: readonly A[]
) => entries.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));

const makeCatalogBrowser = Effect.fn("CatalogBrowser.make")(function* make(
  options: CatalogBrowserOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const catalog = yield* FlowSkillCatalog;

  const exists = (target: string) =>
    fileSystem
      .exists(target)
      .pipe(Effect.mapError(ioError(`Could not read ${target}`)));

  const directoryNames = Effect.fnUntraced(function* readNames(
    directory: string
  ) {
    if (!(yield* exists(directory))) {
      return [];
    }
    return yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.mapError(ioError(`Could not read ${directory}`)));
  });

  /**
   * One JSON document. A file still being written, or one written by a
   * version this one cannot decode, is unreadable rather than fatal: one bad
   * Run must not hide the rest of the catalog.
   */
  const readJson = <A>(
    file: string,
    decode: (contents: string) => Effect.Effect<A, Schema.SchemaError>
  ): Effect.Effect<Read<A>, CatalogBrowserError> =>
    Effect.gen(function* readDocument() {
      if (!(yield* exists(file))) {
        return { _tag: "absent" } as const;
      }
      const contents = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.mapError(ioError(`Could not read ${file}`)));
      return yield* decode(contents).pipe(
        Effect.map((value) => ({ _tag: "read", value }) as const),
        Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const)
      );
    });

  const flowSkills = Effect.fnUntraced(function* listFlowSkills(root: string) {
    const names = (yield* directoryNames(root))
      .filter(isFlowSkillDirectory)
      .toSorted();
    const packages = yield* Effect.forEach(
      names,
      (name) =>
        catalog.read(name, root).pipe(
          Effect.map((skill) => [catalogFlowSkillEntry(skill)]),
          // A directory without SKILL.md is somebody else's, not a broken
          // Flow Skill, which is also how the catalog itself lists them.
          Effect.catchIf(
            (error) => error.code === "flow_skill_not_found",
            () => Effect.succeed([])
          ),
          Effect.mapError((error) => browserError("catalog_io", error.message))
        ),
      { concurrency: READ_CONCURRENCY }
    );
    return packages.flat();
  });

  const summaries = (files: readonly string[]) =>
    Effect.forEach(files, (file) => readJson(file, decodeSummary), {
      concurrency: READ_CONCURRENCY,
    });

  const view = Effect.fnUntraced(function* readRoot(
    scope: CatalogRootScope,
    root: string
  ) {
    const recordingsDirectory = path.join(root, TEACHING_RECORDINGS_DIRECTORY);
    const runsDirectory = path.join(root, AGENT_RUNS_DIRECTORY);
    const recordingIds = (yield* directoryNames(recordingsDirectory)).filter(
      (name) => !name.startsWith(".")
    );
    const runIds = (yield* directoryNames(runsDirectory)).filter(
      (name) => !name.startsWith(".")
    );
    const [skills, manifests, runs, dryRuns] = yield* Effect.all(
      [
        flowSkills(root),
        Effect.forEach(
          recordingIds,
          (id) =>
            readJson(
              path.join(recordingsDirectory, id, MANIFEST_FILE),
              decodeManifest
            ),
          { concurrency: READ_CONCURRENCY }
        ),
        summaries(
          runIds.map((id) => path.join(runsDirectory, id, SUMMARY_FILE))
        ),
        summaries(
          recordingIds.map((id) =>
            path.join(recordingsDirectory, id, DRY_RUN_DIRECTORY, SUMMARY_FILE)
          )
        ),
      ],
      { concurrency: "unbounded" }
    );
    const unreadable = [...manifests, ...runs, ...dryRuns].filter(
      (entry) => entry._tag === "unreadable"
    ).length;
    return {
      flowSkills: skills,
      path: root,
      present: yield* exists(root),
      recordings: readValues(manifests)
        .map(catalogRecordingEntry)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
      runs: newestFirst(
        [...readValues(runs), ...readValues(dryRuns)].map(catalogRunEntry)
      ),
      scope,
      unreadable,
    } satisfies CatalogRootView;
  });

  const globalRoot = () => {
    if (options.globalRoot === undefined) {
      return;
    }
    const resolved = path.resolve(options.globalRoot);
    return resolved === path.resolve(options.localRoot())
      ? undefined
      : resolved;
  };

  const browse = Effect.fnUntraced(function* browseCatalogRoots() {
    const local = yield* view("local", path.resolve(options.localRoot()));
    const global = globalRoot();
    return {
      roots:
        global === undefined ? [local] : [local, yield* view("global", global)],
    };
  });

  const flowSkill = Effect.fnUntraced(function* readFlowSkill(
    scope: CatalogRootScope,
    name: FlowSkillName
  ) {
    const root =
      scope === "local" ? path.resolve(options.localRoot()) : globalRoot();
    if (root === undefined) {
      return yield* Effect.fail(
        browserError(
          "flow_skill_not_found",
          "This Workspace lists no global Catalog Root."
        )
      );
    }
    const skill = yield* catalog
      .read(name, root)
      .pipe(
        Effect.mapError((error) =>
          browserError(
            error.code === "flow_skill_not_found"
              ? "flow_skill_not_found"
              : "catalog_io",
            error.message
          )
        )
      );
    return {
      entry: catalogFlowSkillEntry(skill),
      files: skill.files,
      steps: skill.steps.map((step) => ({
        description: step.description,
        doneWhen: step.doneWhen,
        name: step.name,
      })),
    } satisfies CatalogFlowSkillResult;
  });

  return CatalogBrowser.of({ browse, flowSkill });
});

export const makeCatalogBrowserLayer = (
  options: CatalogBrowserOptions
): Layer.Layer<
  CatalogBrowserService,
  never,
  FileSystem.FileSystem | FlowSkillCatalogService
> => Layer.effect(CatalogBrowser, makeCatalogBrowser(options));
