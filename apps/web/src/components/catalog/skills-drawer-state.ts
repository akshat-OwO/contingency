import type {
  AgentSessionSnapshot,
  CatalogFlowSkillEntry,
  CatalogRecordingEntry,
  CatalogRootScope,
  CatalogRootView,
  CatalogRunEntry,
} from "@contingency/protocol";
import { Atom } from "effect/reactivity";

import { sessionTaskRun } from "@/components/agent/run-provenance";

/**
 * The Skills drawer: the Workspace's read-only browser over the Catalog
 * Roots, opened from the dock. Its open state and the selection beside it are
 * shared by the dock, the drawer, and the details panel, so they are atoms
 * rather than one component's state.
 */
export const skillsDrawerOpenAtom = Atom.make(false);

/** What the details panel shows: a skill's package, a Run, or a recording. */
export type SkillsSelection =
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
      readonly kind: "skill";
      readonly name: CatalogFlowSkillEntry["name"];
      readonly scope: CatalogRootScope;
    };

export const skillsSelectionAtom = Atom.make<SkillsSelection | null>(null);

/** A listed skill, or retained history without a listed skill. */
export type SkillsFolder =
  | { readonly kind: "loose"; readonly scope: CatalogRootScope }
  | { readonly kind: "recordings"; readonly scope: CatalogRootScope }
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly scope: CatalogRootScope;
    };

export const sameFolder = (
  a: SkillsFolder | undefined,
  b: SkillsFolder
): boolean =>
  a !== undefined &&
  a.kind === b.kind &&
  a.scope === b.scope &&
  (a.kind !== "skill" || (b.kind === "skill" && a.name === b.name));

export const sameSelection = (
  a: SkillsSelection | null,
  b: SkillsSelection
): boolean => {
  if (a === null || a.kind !== b.kind || a.scope !== b.scope) {
    return false;
  }
  if (a.kind === "skill" && b.kind === "skill") {
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
 * and which Flow Skills it is about.
 */
export type SkillsSessionView =
  | {
      readonly activity: "teaching";
      readonly captureState: string;
      readonly flowSkillName: string;
    }
  | {
      readonly activity: "run";
      readonly dryRun: boolean;
      readonly flowSkillNames: readonly string[];
    };

export const skillsSessionView = (
  session: AgentSessionSnapshot | undefined
): SkillsSessionView | undefined => {
  if (session === undefined) {
    return undefined;
  }
  if (session.activity === "teaching") {
    return {
      activity: "teaching",
      captureState: session.captureState._tag,
      flowSkillName: session.flowSkillName,
    };
  }
  const taskRun = sessionTaskRun(session);
  const flowSkillNames =
    taskRun === undefined
      ? [session.flowSkillName].filter((name) => name !== null)
      : taskRun.referencedSkills.map((skill) => skill.flowSkillName);
  return { activity: "run", dryRun: session.dryRun !== null, flowSkillNames };
};

/** Capture is user-led; nothing in the dock competes with the journey. */
const CAPTURING = new Set(["recording", "finalizing"]);

/** Whether the dock offers the Skills entry in this session's state. */
export const showsSkillsEntry = (
  session: SkillsSessionView | undefined
): boolean =>
  session?.activity !== "teaching" || !CAPTURING.has(session.captureState);

/** Teaching states whose Flow Skill has not been written to disk yet. */
const UNSAVED = new Set([
  "setup",
  "recording",
  "finalizing",
  "ready",
  "learning",
  "failed",
]);

/**
 * How the drawer marks the selected session's own skills. A skill still being
 * taught has no directory yet, so it is `pending` and holds a placeholder row;
 * a saved one is labelled where it is listed.
 */
export interface SessionSkills {
  readonly labels: ReadonlyMap<string, string>;
  readonly pending: string | undefined;
}

export const sessionSkills = (
  session: SkillsSessionView | undefined
): SessionSkills => {
  if (session === undefined) {
    return { labels: new Map(), pending: undefined };
  }
  if (session.activity === "teaching") {
    return UNSAVED.has(session.captureState)
      ? { labels: new Map(), pending: session.flowSkillName }
      : {
          labels: new Map([[session.flowSkillName, "This session"]]),
          pending: undefined,
        };
  }
  const label = session.dryRun ? "This Dry Run" : "In this run";
  return {
    labels: new Map(session.flowSkillNames.map((name) => [name, label])),
    pending: undefined,
  };
};

export const matchesQuery = (
  skill: Pick<CatalogFlowSkillEntry, "name">,
  query: string
): boolean => skill.name.toLowerCase().includes(query.trim().toLowerCase());

export const runsForSkill = (
  root: CatalogRootView,
  name: string
): readonly CatalogRunEntry[] =>
  root.runs.filter((run) => run.flowSkillNames.some((skill) => skill === name));

export const recordingsForSkill = (
  root: CatalogRootView,
  name: string
): readonly CatalogRecordingEntry[] =>
  root.recordings.filter((recording) => recording.flowSkillName === name);

/**
 * Runs no listed skill in this root claims: Runs that referenced no skill,
 * and Runs whose skills live elsewhere, such as a bundled Example.
 */
export const looseRuns = (root: CatalogRootView): readonly CatalogRunEntry[] =>
  root.runs.filter(
    (run) =>
      !run.flowSkillNames.some((name) =>
        root.flowSkills.some((skill) => skill.name === name)
      )
  );

export const orphanRecordings = (
  root: CatalogRootView
): readonly CatalogRecordingEntry[] => {
  const listed = new Set(root.flowSkills.map((skill) => skill.name));
  return root.recordings.filter(
    (recording) => !listed.has(recording.flowSkillName)
  );
};

export const hasBrowsableEntries = (root: CatalogRootView): boolean =>
  root.flowSkills.length > 0 ||
  root.runs.length > 0 ||
  root.recordings.length > 0;

/** Ignore a choice whose folder disappeared on a catalog refresh. */
export const availableFolder = (
  folder: SkillsFolder | null,
  roots: readonly CatalogRootView[],
  skills: SessionSkills
): SkillsFolder | undefined => {
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
  return root.flowSkills.some((skill) => skill.name === folder.name) ||
    (folder.scope === "local" && skills.pending === folder.name)
    ? folder
    : undefined;
};

export const skillCount = (roots: readonly CatalogRootView[]): number =>
  roots.reduce((total, root) => total + root.flowSkills.length, 0);

export const runCountLabel = (count: number): string => {
  if (count === 0) {
    return "no runs";
  }
  return count === 1 ? "1 run" : `${count} runs`;
};

/**
 * Prefer Teaching and the session's listed skill, then browse local-first.
 */
export const defaultFolder = (
  roots: readonly CatalogRootView[],
  skills: SessionSkills
): SkillsFolder | undefined => {
  if (skills.pending !== undefined) {
    return { kind: "skill", name: skills.pending, scope: "local" };
  }
  for (const root of roots) {
    const own = root.flowSkills.find((skill) => skills.labels.has(skill.name));
    if (own !== undefined) {
      return { kind: "skill", name: own.name, scope: root.scope };
    }
  }
  for (const root of roots) {
    const first = root.flowSkills.at(0);
    if (first !== undefined) {
      return { kind: "skill", name: first.name, scope: root.scope };
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
 * something to show, and no local skill is being taught.
 */
export const opensGlobal = (
  roots: readonly CatalogRootView[],
  query: string,
  skills: SessionSkills
): boolean => {
  const [local, global] = roots;
  const hits = (root: CatalogRootView | undefined) =>
    root !== undefined &&
    (query.trim() === ""
      ? hasBrowsableEntries(root)
      : root.flowSkills.some((skill) => matchesQuery(skill, query)));
  return !hits(local) && hits(global) && skills.pending === undefined;
};
