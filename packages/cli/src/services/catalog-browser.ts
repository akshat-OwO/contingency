import os from "node:os";
import path from "node:path";

import {
  AgentRunSummary,
  FlowName,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import type {
  CatalogBrowseResult,
  CatalogFlowEntry,
  CatalogFlowResult,
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
import { discoverFlows } from "./flow-catalog-layout.ts";
import { GLOBAL_CATALOG_DIRECTORY, FlowCatalog } from "./flow-catalog.ts";
import type { FlowCatalogService } from "./flow-catalog.ts";
import { readFlowContractFiles } from "./flow-contract-files.ts";
import {
  flowProcedureSteps,
  readFlowFrontmatter,
  FLOW_FILE,
} from "./flow-package.ts";
import { isVerifiedFlow } from "./requested-flows.ts";
import { TEACHING_RECORDINGS_DIRECTORY } from "./teaching-recording-store.ts";

/**
 * The Workspace's read-only view of Catalog Roots for the Flows Drawer.
 *
 * It lists the Flows, persisted Runs, and Teaching Recordings of the
 * process's own Catalog Root, and of the user's `~/.contingency` when that is
 * a different directory. It reads manifests and Run Summaries, never videos,
 * Traces, or keyframes, and it writes nothing. The global root is a Workspace
 * convenience only: no MCP tool reads it, so an agent still never searches a
 * user-global catalog (ADR 0051).
 */

export interface CatalogBrowserError {
  readonly _tag: "CatalogBrowserError";
  readonly code: "catalog_io" | "flow_not_found";
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
  readonly flow: (
    scope: CatalogRootScope,
    name: FlowName
  ) => Effect.Effect<CatalogFlowResult, CatalogBrowserError>;
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
    : path.join(os.homedir(), GLOBAL_CATALOG_DIRECTORY);
};

const SUMMARY_FILE = "summary.json";
const MANIFEST_FILE = "manifest.json";
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
      flowNames: summary.referencedFlows.map((flow) => flow.flowName),
      kind: summary.purpose.kind,
      outcome: summary.outcome,
      ownerFlow: null,
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
    flowNames: summary.schemaVersion === 2 ? [summary.flowName] : [],
    kind: "legacy",
    outcome: summary.outcome,
    ownerFlow: null,
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
  flowName: manifest.flowName,
  keyframeCount: manifest.artifacts.filter(
    (artifact) => artifact.kind === "keyframe"
  ).length,
  ownerFlow: manifest.flowName,
  phase: manifest.lifecycle._tag,
  recordingId: manifest.recordingId,
});

/** A list entry from a flow's flow.md and the files beside it. */
export const catalogFlowEntry = (
  name: FlowName,
  flowContent: string,
  files: readonly { readonly content: string; readonly path: string }[]
): CatalogFlowEntry => {
  const frontmatter = readFlowFrontmatter(flowContent);
  const hosts = frontmatter?.hosts ?? [];
  const entry: Mutable<CatalogFlowEntry> = {
    description: frontmatter?.description ?? name,
    groupPath: [],
    hosts,
    name,
    stepCount: flowProcedureSteps(flowContent).length,
    verified: isVerifiedFlow(files),
  };
  if (isDemoHosts(hosts)) {
    entry.demo = DEMO_SITE_ID;
  }
  return entry;
};

type Read<A> =
  | { readonly _tag: "absent" }
  | { readonly _tag: "read"; readonly value: A }
  | { readonly _tag: "unreadable" };

const documentReadFailure = (error: PlatformError): Read<never> => ({
  _tag: error.reason._tag === "NotFound" ? "absent" : "unreadable",
});

const newestFirst = <A extends { readonly startedAt: string }>(
  entries: readonly A[]
) => entries.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));

const makeCatalogBrowser = Effect.fn("CatalogBrowser.make")(function* make(
  options: CatalogBrowserOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const catalog = yield* FlowCatalog;

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
   * One JSON document. Missing files are absent, including read races.
   * Typed read and decode failures count once as unreadable; defects and
   * interruption still escape. Root enumeration uses its own fatal handler.
   */
  const readJson = <A>(
    file: string,
    decode: (contents: string) => Effect.Effect<A, Schema.SchemaError>
  ): Effect.Effect<Read<A>> =>
    Effect.gen(function* readDocument() {
      const contents = yield* fileSystem.readFileString(file);
      return yield* decode(contents).pipe(
        Effect.map((value) => ({ _tag: "read", value }) as const),
        Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const)
      );
    }).pipe(Effect.orElseSucceed(documentReadFailure));

  const flows = Effect.fnUntraced(function* listFlows(root: string) {
    const discovered = yield* discoverFlows(root, fileSystem).pipe(
      Effect.mapError((cause) => browserError("catalog_io", cause.message))
    );
    const entries: CatalogFlowEntry[] = [];
    for (const [name, flow] of [...discovered].toSorted(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (flow.kind === "draft") {
        continue;
      }
      const contracts = yield* readFlowContractFiles(
        flow.directory,
        fileSystem
      ).pipe(Effect.orElseSucceed(() => null));
      const entry = catalogFlowEntry(FlowName.make(name), flow.content, [
        { content: flow.content, path: FLOW_FILE },
        ...(contracts ?? []),
      ]);
      entries.push({
        ...entry,
        groupPath: path
          .relative(root, path.dirname(flow.directory))
          .split(path.sep)
          .filter(Boolean),
        verified: contracts !== null && entry.verified,
      });
    }
    return entries;
  });

  const summaries = (files: readonly string[]) =>
    Effect.forEach(files, (file) => readJson(file, decodeSummary), {
      concurrency: READ_CONCURRENCY,
    });

  const view = Effect.fnUntraced(function* readRoot(
    scope: CatalogRootScope,
    root: string
  ) {
    const discovered = yield* discoverFlows(root, fileSystem).pipe(
      Effect.orElseSucceed(() => new Map<string, { directory: string }>())
    );
    const recordingDirectories: string[] = [];
    const recordingOwners = new Map<string, FlowName>();
    const runOwners = new Map<string, FlowName>();
    for (const [name, flow] of discovered) {
      const directory = path.join(
        flow.directory,
        TEACHING_RECORDINGS_DIRECTORY
      );
      for (const id of yield* directoryNames(directory)) {
        if (!id.startsWith(".")) {
          recordingDirectories.push(path.join(directory, id));
          recordingOwners.set(
            path.join(directory, id, MANIFEST_FILE),
            FlowName.make(name)
          );
        }
      }
    }
    const runFiles: string[] = [];
    for (const directory of [
      root,
      ...[...discovered.values()].map((flow) => flow.directory),
    ]) {
      const runsDirectory = path.join(directory, AGENT_RUNS_DIRECTORY);
      for (const id of yield* directoryNames(runsDirectory)) {
        if (!id.startsWith(".")) {
          const file = path.join(runsDirectory, id, SUMMARY_FILE);
          runFiles.push(file);
          const owner = [...discovered].find(
            ([, flow]) => flow.directory === directory
          );
          if (owner !== undefined) {
            runOwners.set(file, FlowName.make(owner[0]));
          }
        }
      }
    }
    const [entries, manifests, runs] = yield* Effect.all(
      [
        flows(root),
        Effect.forEach(
          recordingDirectories,
          (id) => readJson(path.join(id, MANIFEST_FILE), decodeManifest),
          { concurrency: READ_CONCURRENCY }
        ),
        summaries(runFiles),
      ],
      { concurrency: "unbounded" }
    );
    const unreadable = [...manifests, ...runs].filter(
      (entry) => entry._tag === "unreadable"
    ).length;
    return {
      flows: entries,
      path: root,
      present: yield* exists(root),
      recordings: manifests
        .flatMap((entry, index) =>
          entry._tag === "read"
            ? [
                {
                  ...catalogRecordingEntry(entry.value),
                  ownerFlow:
                    recordingOwners.get(
                      path.join(
                        recordingDirectories[index] ?? "",
                        MANIFEST_FILE
                      )
                    ) ?? entry.value.flowName,
                },
              ]
            : []
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
      runs: newestFirst(
        runs.flatMap((entry, index) =>
          entry._tag === "read"
            ? [
                {
                  ...catalogRunEntry(entry.value),
                  ownerFlow: runOwners.get(runFiles[index] ?? "") ?? null,
                },
              ]
            : []
        )
      ),
      scope,
      unreadable,
    } satisfies CatalogRootView;
  });

  /** A directory's real path, so a symlinked root compares as its target. */
  const realRoot = (directory: string) =>
    fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => path.resolve(directory)));

  /** The global root, unless it is the local root by another name. */
  const globalRoot = Effect.fnUntraced(function* resolveGlobalRoot() {
    if (options.globalRoot === undefined) {
      return null;
    }
    const global = yield* realRoot(options.globalRoot);
    const local = yield* realRoot(options.localRoot());
    return global === local ? null : path.resolve(options.globalRoot);
  });

  const browse = Effect.fnUntraced(function* browseCatalogRoots() {
    const local = yield* view("local", path.resolve(options.localRoot()));
    const global = yield* globalRoot();
    return {
      roots: global === null ? [local] : [local, yield* view("global", global)],
    };
  });

  const readCatalogFlow = Effect.fnUntraced(function* readFlow(
    scope: CatalogRootScope,
    name: FlowName
  ) {
    const root =
      scope === "local"
        ? path.resolve(options.localRoot())
        : yield* globalRoot();
    if (root === null) {
      return yield* Effect.fail(
        browserError(
          "flow_not_found",
          "This Workspace lists no global Catalog Root."
        )
      );
    }
    const flow = yield* catalog
      .read(name, root)
      .pipe(
        Effect.mapError((error) =>
          browserError(
            error.code === "flow_not_found" ? "flow_not_found" : "catalog_io",
            error.message
          )
        )
      );
    return {
      entry: catalogFlowEntry(
        flow.name,
        flow.files.find((file) => file.path === FLOW_FILE)?.content ?? "",
        flow.files
      ),
      files: flow.files,
      steps: flow.steps.map((step) => ({
        description: step.description,
        doneWhen: step.doneWhen,
        name: step.name,
      })),
    } satisfies CatalogFlowResult;
  });

  return CatalogBrowser.of({ browse, flow: readCatalogFlow });
});

export const makeCatalogBrowserLayer = (
  options: CatalogBrowserOptions
): Layer.Layer<
  CatalogBrowserService,
  never,
  FileSystem.FileSystem | FlowCatalogService
> => Layer.effect(CatalogBrowser, makeCatalogBrowser(options));
