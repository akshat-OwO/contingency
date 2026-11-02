import type {
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
 * The Flows drawer: the Workspace's read-only browser over the Catalog
 * Roots, opened from the dock. Its open state and the selection beside it are
 * shared by the dock, the drawer, and the details panel, so they are atoms
 * rather than one component's state.
 */
export const flowsDrawerOpenAtom = Atom.make(false);

/** What the details panel shows: a flow's package, a Run, or a recording. */
export type FlowsSelection =
  | {
      readonly kind: "recording";
      readonly recording: CatalogRecordingEntry;
      readonly scope: CatalogRootScope;
    }
  | {
      readonly kind: "run";
      readonly run: CatalogRunEntry;
      readonly scope: CatalogRootScope;
    }
  | {
      readonly kind: "flow";
      readonly name: CatalogFlowEntry["name"];
      readonly scope: CatalogRootScope;
    };

export const flowsSelectionAtom = Atom.make<FlowsSelection | null>(null);

/** A listed flow, or retained history without a listed flow. */
export type FlowsFolder =
  | { readonly kind: "loose"; readonly scope: CatalogRootScope }
  | { readonly kind: "recordings"; readonly scope: CatalogRootScope }
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

export const sameSelection = (
  a: FlowsSelection | null,
  b: FlowsSelection
): boolean => {
  if (a === null || a.kind !== b.kind || a.scope !== b.scope) {
    return false;
  }
  if (a.kind === "flow" && b.kind === "flow") {
    return a.name === b.name;
  }
  if (a.kind === "run" && b.kind === "run") {
    return a.run.runId === b.run.runId;
  }
  return (
    a.kind === "recording" &&
    b.kind === "recording" &&
    a.recording.recordingId === b.recording.recordingId
  );
};

/**
 * What the drawer needs to know about the selected session: what it is doing,
 * and which Flows it is about.
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

/** Capture is user-led; nothing in the dock competes with the journey. */
const CAPTURING = new Set(["recording", "finalizing"]);

/** Whether the dock offers the Flows entry in this session's state. */
export const showsFlowsEntry = (
  session: FlowsSessionView | undefined
): boolean =>
  session?.activity !== "teaching" || !CAPTURING.has(session.captureState);

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
 * How the drawer marks the selected session's own flows. A flow still being
 * taught has no directory yet, so it is `pending` and holds a placeholder row;
 * a saved one is labelled where it is listed.
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
  const label = session.dryRun ? "This Dry Run" : "In this run";
  return {
    labels: new Map(session.flowNames.map((name) => [name, label])),
    pending: undefined,
  };
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

export const orphanRecordings = (
  root: CatalogRootView
): readonly CatalogRecordingEntry[] => {
  const listed = new Set(root.flows.map((flow) => flow.name));
  return root.recordings.filter(
    (recording) => !listed.has(recording.ownerFlow ?? recording.flowName)
  );
};

export const hasBrowsableEntries = (root: CatalogRootView): boolean =>
  root.flows.length > 0 || root.runs.length > 0 || root.recordings.length > 0;

/** Ignore a choice whose folder disappeared on a catalog refresh. */
export const availableFolder = (
  folder: FlowsFolder | null,
  roots: readonly CatalogRootView[],
  flows: SessionFlows
): FlowsFolder | undefined => {
  const root = roots.find((entry) => entry.scope === folder?.scope);
  if (folder === null || root === undefined) {
    return undefined;
  }
  if (folder.kind === "loose") {
    return looseRuns(root).length > 0 ? folder : undefined;
  }
  if (folder.kind === "recordings") {
    return orphanRecordings(root).length > 0 ? folder : undefined;
  }
  return root.flows.some((flow) => flow.name === folder.name) ||
    (folder.scope === "local" && flows.pending === folder.name)
    ? folder
    : undefined;
};

export const flowCount = (roots: readonly CatalogRootView[]): number =>
  roots.reduce((total, root) => total + root.flows.length, 0);

export const runCountLabel = (count: number): string => {
  if (count === 0) {
    return "no runs";
  }
  return count === 1 ? "1 run" : `${count} runs`;
};

/**
 * Prefer Teaching and the session's listed flow, then browse local-first.
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
    if (looseRuns(root).length > 0) {
      return { kind: "loose", scope: root.scope };
    }
    if (orphanRecordings(root).length > 0) {
      return { kind: "recordings", scope: root.scope };
    }
  }
  return undefined;
};

/**
 * Whether the global root starts unfolded: only when it is the one place with
 * something to show, and no local flow is being taught.
 */
export const opensGlobal = (
  roots: readonly CatalogRootView[],
  query: string,
  flows: SessionFlows
): boolean => {
  const [local, global] = roots;
  const hits = (root: CatalogRootView | undefined) =>
    root !== undefined &&
    (query.trim() === ""
      ? hasBrowsableEntries(root)
      : root.flows.some((flow) => matchesQuery(flow, query)));
  return !hits(local) && hits(global) && flows.pending === undefined;
};
