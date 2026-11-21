import type {
  AgentRunId,
  AgentSessionSnapshot,
  CatalogFlowEntry,
  CatalogRecordingEntry,
  CatalogRootScope,
  CatalogRootView,
  CatalogRunEntry,
} from "@contingency/protocol";
import { Atom } from "effect/reactivity";

import { sessionTaskRun } from "@/components/agent/run-provenance";

/**
 * What the Flows page needs to know about the session it was opened from:
 * what it is doing, and which Flows it is about.
 */
export type FlowsSessionView =
  | {
      readonly activity: "teaching";
      readonly captureState: string;
      readonly flowName: string;
    }
  | {
      readonly activity: "run";
      readonly dryRun: boolean;
      readonly flowNames: readonly string[];
    };

/**
 * The session the **Flows** button was pressed in. The page marks its Flow
 * and opens on it. A `/flow` link opened directly has none. Nothing reads it
 * between the press and the page mounting, so it is kept alive.
 */
export const flowsOriginAtom = Atom.make<FlowsSessionView | null>(null).pipe(
  Atom.keepAlive
);

export const flowsSessionView = (
  session: AgentSessionSnapshot | undefined
): FlowsSessionView | undefined => {
  if (session === undefined) {
    return undefined;
  }
  if (session.activity === "teaching") {
    return {
      activity: "teaching",
      captureState: session.captureState._tag,
      flowName: session.flowName,
    };
  }
  const taskRun = sessionTaskRun(session);
  const flowNames =
    taskRun === undefined
      ? [session.flowName].filter((name) => name !== null)
      : taskRun.referencedFlows.map((flow) => flow.flowName);
  return { activity: "run", dryRun: session.dryRun !== null, flowNames };
};

/** Teaching states whose Flow has not been written to disk yet. */
const UNSAVED = new Set([
  "setup",
  "recording",
  "finalizing",
  "ready",
  "learning",
  "failed",
]);

/**
 * How the page marks the session's own Flows. A Flow still being taught has
 * no directory yet, so it is `pending` and holds a placeholder row; a saved
 * one is labelled where it is listed.
 */
export interface SessionFlows {
  readonly labels: ReadonlyMap<string, string>;
  readonly pending: string | undefined;
}

export const sessionFlows = (
  session: FlowsSessionView | undefined
): SessionFlows => {
  if (session === undefined) {
    return { labels: new Map(), pending: undefined };
  }
  if (session.activity === "teaching") {
    return UNSAVED.has(session.captureState)
      ? { labels: new Map(), pending: session.flowName }
      : {
          labels: new Map([[session.flowName, "This session"]]),
          pending: undefined,
        };
  }
  return {
    labels: new Map(session.flowNames.map((name) => [name, "This session"])),
    pending: undefined,
  };
};

/**
 * What the page shows: one Flow, or a Catalog Root's own history (Runs that
 * used no Flow or several, and recordings whose Flow is gone).
 */
export type FlowsFolder =
  | { readonly kind: "root"; readonly scope: CatalogRootScope }
  | {
      readonly kind: "flow";
      readonly name: string;
      readonly scope: CatalogRootScope;
    };

export const sameFolder = (
  a: FlowsFolder | undefined,
  b: FlowsFolder
): boolean =>
  a !== undefined &&
  a.kind === b.kind &&
  a.scope === b.scope &&
  (a.kind !== "flow" || (b.kind === "flow" && a.name === b.name));

/** The Catalog Root's own history in `?flow=`. No Flow name starts with `@`. */
const ROOT = "@root";
const GLOBAL = "global:";

/**
 * A folder as the `?flow=` value: the Flow's name, `@root` for the root's
 * history, and `global:` before either for the user-global root.
 */
export const folderParam = (folder: FlowsFolder): string => {
  const name = folder.kind === "root" ? ROOT : folder.name;
  return folder.scope === "global" ? `${GLOBAL}${name}` : name;
};

export const folderFromParam = (
  value: string | undefined
): FlowsFolder | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  const scope = value.startsWith(GLOBAL) ? "global" : "local";
  const name = scope === "global" ? value.slice(GLOBAL.length) : value;
  if (name === "") {
    return undefined;
  }
  return name === ROOT
    ? { kind: "root", scope }
    : { kind: "flow", name, scope };
};

export const matchesQuery = (
  flow: Pick<CatalogFlowEntry, "name">,
  query: string
): boolean => flow.name.toLowerCase().includes(query.trim().toLowerCase());

export const runsForFlow = (
  root: CatalogRootView,
  name: string
): readonly CatalogRunEntry[] =>
  root.runs.filter((run) => run.ownerFlow === name);

/** The platform a Flow runs on, as its icon and chip name it. */
export type FlowPlatform = "android" | "ios" | "web";

/**
 * A Flow's platform, as far as the catalog tells: a native Run of it names
 * its device platform, and stamped hosts mean the browser. A Flow with
 * neither, such as a native draft with no Run yet, has none to show.
 */
export const flowPlatform = (
  root: CatalogRootView,
  flow: Pick<CatalogFlowEntry, "hosts" | "name">
): FlowPlatform | undefined => {
  const native = runsForFlow(root, flow.name).find(
    (run) => run.native !== undefined
  )?.native;
  if (native !== undefined) {
    return native.platform;
  }
  return flow.hosts.length > 0 ? "web" : undefined;
};

export const recordingsForFlow = (
  root: CatalogRootView,
  name: string
): readonly CatalogRecordingEntry[] =>
  root.recordings.filter((recording) => recording.ownerFlow === name);

/**
 * Runs stored directly in the Catalog Root, including zero-Flow and multi-Flow Runs.
 */
export const looseRuns = (root: CatalogRootView): readonly CatalogRunEntry[] =>
  root.runs.filter((run) => run.ownerFlow === null);

/**
 * Recordings whose Flow is not listed. A Flow still being taught is listed
 * under its own placeholder, so its recordings stay with it.
 */
export const orphanRecordings = (
  root: CatalogRootView,
  pending?: string
): readonly CatalogRecordingEntry[] => {
  const listed = new Set<string>(root.flows.map((flow) => flow.name));
  if (pending !== undefined) {
    listed.add(pending);
  }
  return root.recordings.filter(
    (recording) => !listed.has(recording.ownerFlow ?? recording.flowName)
  );
};

/** How many entries the root's own history holds. */
export const rootHistoryCount = (
  root: CatalogRootView,
  pending?: string
): number => looseRuns(root).length + orphanRecordings(root, pending).length;

export const hasBrowsableEntries = (root: CatalogRootView): boolean =>
  root.flows.length > 0 || root.runs.length > 0 || root.recordings.length > 0;

/** Ignore a choice whose folder is not, or no longer, in the catalog. */
export const availableFolder = (
  folder: FlowsFolder | undefined,
  roots: readonly CatalogRootView[],
  flows: SessionFlows
): FlowsFolder | undefined => {
  const root = roots.find((entry) => entry.scope === folder?.scope);
  if (folder === undefined || root === undefined) {
    return undefined;
  }
  if (folder.kind === "root") {
    return rootHistoryCount(root, flows.pending) > 0 ? folder : undefined;
  }
  return root.flows.some((flow) => flow.name === folder.name) ||
    (folder.scope === "local" && flows.pending === folder.name)
    ? folder
    : undefined;
};

export const flowCount = (roots: readonly CatalogRootView[]): number =>
  roots.reduce((total, root) => total + root.flows.length, 0);

/**
 * Prefer the Flow being taught and the session's listed Flow, then browse
 * local-first.
 */
export const defaultFolder = (
  roots: readonly CatalogRootView[],
  flows: SessionFlows
): FlowsFolder | undefined => {
  if (flows.pending !== undefined) {
    return { kind: "flow", name: flows.pending, scope: "local" };
  }
  for (const root of roots) {
    const own = root.flows.find((flow) => flows.labels.has(flow.name));
    if (own !== undefined) {
      return { kind: "flow", name: own.name, scope: root.scope };
    }
  }
  for (const root of roots) {
    const first = root.flows.at(0);
    if (first !== undefined) {
      return { kind: "flow", name: first.name, scope: root.scope };
    }
    if (rootHistoryCount(root, flows.pending) > 0) {
      return { kind: "root", scope: root.scope };
    }
  }
  return undefined;
};

/**
 * Where a Run is listed: under its Flow, or in its root's history. `/?run=`
 * links name only the Run, so the page finds its folder here.
 */
export const folderOfRun = (
  roots: readonly CatalogRootView[],
  runId: AgentRunId
): FlowsFolder | undefined => {
  for (const root of roots) {
    const run = root.runs.find((entry) => entry.runId === runId);
    if (run !== undefined) {
      return run.ownerFlow === null
        ? { kind: "root", scope: root.scope }
        : { kind: "flow", name: run.ownerFlow, scope: root.scope };
    }
  }
  return undefined;
};

/**
 * Whether the user-global root starts shown: when the page opens on it, or
 * when it is the one place with anything to show.
 */
export const showsGlobalAtFirst = (
  roots: readonly CatalogRootView[],
  folder: FlowsFolder | undefined
): boolean => {
  if (folder?.scope === "global") {
    return true;
  }
  const local = roots.find((root) => root.scope === "local");
  const global = roots.find((root) => root.scope === "global");
  return (
    (local === undefined || !hasBrowsableEntries(local)) &&
    global !== undefined &&
    hasBrowsableEntries(global)
  );
};
