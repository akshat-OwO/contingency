import { randomUUID } from "node:crypto";

import type {
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentFlowDraftRef,
  AgentSessionId,
  AgentSnapshotId,
  CapturedAction,
  TeachingFeed,
  TeachingInstruction,
  TeachingProgress,
  TeachingScreenshot,
} from "@contingency/protocol";

import { observedHosts } from "./agent-flow-compiler.ts";
import type { Demonstration } from "./agent-flow-compiler.ts";

/** How many captured actions one Demonstration keeps. */
const ACTION_LIMIT = 2000;
/** How many relayed instructions one Demonstration keeps. */
const INSTRUCTION_LIMIT = 200;
/** How many Browser Snapshots one Demonstration keeps for evidence. */
const SNAPSHOT_LIMIT = 400;
/** How many URL transitions one Demonstration keeps. */
const TRANSITION_LIMIT = 4000;

/**
 * What one captured action reports before the Demonstration adds identity and
 * the Page's state around it.
 */
export interface CapturedActionInput {
  readonly action: CapturedAction["action"];
  readonly actor: CapturedAction["actor"];
  readonly at: string;
  readonly description: string;
  readonly detail?: string | undefined;
  readonly id: string;
  readonly outcome: CapturedAction["outcome"];
  readonly snapshotAfter: AgentBrowserSnapshot | null;
  readonly snapshotBefore: AgentSnapshotId | null;
  readonly urlAfter: string;
  readonly urlBefore: string;
}

/**
 * The in-process recorder behind one Teaching session. It keeps the
 * Demonstration — actor-attributed actions, the Browser Snapshots around them,
 * URL transitions, and relayed user instructions — and derives the bounded
 * Teaching Feed from it. Nothing here touches the browser: the session feeds
 * it what the browser already answered.
 */
export interface DemonstrationCapture {
  readonly current: () => Demonstration;
  readonly feed: (
    sessionId: AgentSessionId,
    includeSnapshots: boolean
  ) => TeachingFeed;
  readonly latestSnapshotId: () => AgentSnapshotId | null;
  readonly progress: (draft: AgentFlowDraftRef | null) => TeachingProgress;
  /** Record one attempt and the URL change it caused, if any. */
  readonly recordAction: (input: CapturedActionInput) => CapturedAction;
  readonly recordInstruction: (text: string, at: string) => TeachingInstruction;
  /** Remember an observation so the next action has a `before` state. */
  readonly recordSnapshot: (snapshot: AgentBrowserSnapshot) => void;
  /** Record one best-effort-masked visual observation. */
  readonly recordScreenshot: (
    screenshot: AgentScreenshot
  ) => TeachingScreenshot;
  /** Note where the Page is; a change with no action is a user transition. */
  readonly recordUrl: (url: string, at: string) => void;
}

/** Drop the oldest entries once a list is past its limit. */
const trim = <A>(list: A[], limit: number): void => {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
};

export const makeDemonstrationCapture = (
  initialUrl: string
): DemonstrationCapture => {
  const actions: CapturedAction[] = [];
  const instructions: TeachingInstruction[] = [];
  const screenshots: TeachingScreenshot[] = [];
  const snapshots = new Map<AgentSnapshotId, AgentBrowserSnapshot>();
  const urlTransitions: Demonstration["urlTransitions"][number][] = [];
  let latestSnapshot: AgentSnapshotId | null = null;
  let currentUrl = initialUrl;
  let lastEventAt = Number.NEGATIVE_INFINITY;

  /** Preserve capture order when several browser events share one clock tick. */
  const eventTime = (at: string): string => {
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) {
      return at;
    }
    const next = Math.max(parsed, lastEventAt + 1);
    lastEventAt = next;
    return new Date(next).toISOString();
  };

  const recordSnapshot = (snapshot: AgentBrowserSnapshot): void => {
    snapshots.set(snapshot.snapshotId, snapshot);
    latestSnapshot = snapshot.snapshotId;
    while (snapshots.size > SNAPSHOT_LIMIT) {
      const oldest = snapshots.keys().next();
      if (oldest.done) {
        break;
      }
      snapshots.delete(oldest.value);
    }
  };

  const transition = (
    to: string,
    at: string,
    actionId: string | null
  ): void => {
    if (to === currentUrl) {
      return;
    }
    urlTransitions.push({ actionId, at, from: currentUrl, to });
    trim(urlTransitions, TRANSITION_LIMIT);
    currentUrl = to;
  };

  const recordAction = (input: CapturedActionInput): CapturedAction => {
    const at = eventTime(input.at);
    if (input.snapshotAfter !== null) {
      recordSnapshot(input.snapshotAfter);
    }
    const captured: CapturedAction = {
      action: input.action,
      actor: input.actor,
      at,
      description: input.description,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      id: input.id,
      outcome: input.outcome,
      snapshotAfter: input.snapshotAfter?.snapshotId ?? null,
      snapshotBefore: input.snapshotBefore,
      urlAfter: input.urlAfter,
      urlBefore: input.urlBefore,
    };
    // The action is what moved the Page, so the transition it caused is
    // attributed to it even when the URL was noticed only afterwards.
    transition(input.urlBefore, at, null);
    transition(input.urlAfter, at, input.id);
    actions.push(captured);
    trim(actions, ACTION_LIMIT);
    return captured;
  };

  const current = (): Demonstration => ({
    actions: [...actions],
    instructions: [...instructions],
    screenshots: [...screenshots],
    snapshots: new Map(snapshots),
    urlTransitions: [...urlTransitions],
  });

  return {
    current,
    feed: (sessionId, includeSnapshots) => {
      const demonstration = current();
      const referenced = new Set<AgentSnapshotId>();
      for (const action of demonstration.actions) {
        if (action.snapshotBefore !== null) {
          referenced.add(action.snapshotBefore);
        }
        if (action.snapshotAfter !== null) {
          referenced.add(action.snapshotAfter);
        }
      }
      return {
        actions: demonstration.actions,
        instructions: demonstration.instructions,
        observedHosts: observedHosts(demonstration),
        screenshots: demonstration.screenshots,
        sessionId,
        snapshots: includeSnapshots
          ? [...referenced]
              .map((id) => demonstration.snapshots.get(id))
              .filter((snapshot) => snapshot !== undefined)
          : [],
        urlTransitions: demonstration.urlTransitions,
      };
    },
    latestSnapshotId: () => latestSnapshot,
    progress: (draft) => ({
      actionCount: actions.length,
      draft,
      instructionCount: instructions.length,
    }),
    recordAction,
    recordInstruction: (text, at) => {
      const instruction: TeachingInstruction = {
        at: eventTime(at),
        id: `instruction-${randomUUID()}`,
        text,
      };
      instructions.push(instruction);
      trim(instructions, INSTRUCTION_LIMIT);
      return instruction;
    },
    recordScreenshot: (screenshot) => {
      const captured: TeachingScreenshot = {
        ...screenshot,
        capturedAt: eventTime(screenshot.capturedAt),
        id: `screenshot-${randomUUID()}`,
      };
      screenshots.push(captured);
      trim(screenshots, SNAPSHOT_LIMIT);
      return captured;
    },
    recordSnapshot,
    recordUrl: (url, at) => transition(url, eventTime(at), null),
  };
};
