import { createHash, randomUUID } from "node:crypto";

import { ScreenshotHash } from "@contingency/protocol";
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
  TeachingScreenshotContent,
  Variable,
} from "@contingency/protocol";

import { observedHosts } from "./agent-flow-compiler.ts";
import type { Demonstration } from "./agent-flow-compiler.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";

/** How many captured actions one Demonstration keeps. */
const ACTION_LIMIT = 2000;
/** How many relayed instructions one Demonstration keeps. */
const INSTRUCTION_LIMIT = 200;
/** How many Browser Snapshots one Demonstration keeps for evidence. */
const SNAPSHOT_LIMIT = 400;
/** How many URL transitions one Demonstration keeps. */
const TRANSITION_LIMIT = 4000;
/** Bound declarations and local-only masking state like captured actions. */
const VARIABLE_LIMIT = 2000;

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
  /** Consecutive semantic edits with this key replace one captured action. */
  readonly coalesceKey?: string | undefined;
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
  /** The bytes behind one recorded screenshot, fetched by its reference. */
  readonly screenshotContent: (
    screenshotId: string
  ) => TeachingScreenshotContent | undefined;
  /** Check whether a declaration is compatible without retaining its value. */
  readonly canRecordVariable: (
    variable: Variable,
    value: string,
    selector: string
  ) => boolean;
  /** Register one declaration, session-only value, and known field after entry. */
  readonly recordVariable: (
    variable: Variable,
    value: string,
    selector: string
  ) => void;
  /** Note where the Page is; a change with no action is a user transition. */
  readonly recordUrl: (url: string, at: string) => void;
  /** Values that screenshot and snapshot capture must mask, longest first. */
  readonly sensitiveValues: () => readonly string[];
  /** Known private fields that screenshot capture must mask. */
  readonly sensitiveSelectors: () => readonly string[];
}

/** Drop the oldest entries once a list is past its limit. */
const trim = <A>(list: A[], limit: number): void => {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
};

const coalescedAction = (
  input: CapturedActionInput,
  previous: CapturedAction | undefined
): CapturedAction["action"] => {
  const next =
    input.action.type === "navigate"
      ? { ...input.action, url: sanitizeTeachingUrl(input.action.url) }
      : input.action;
  return previous?.action.type === "fill" && next.type === "fill"
    ? { ...next, ref: previous.action.ref }
    : next;
};

export const makeDemonstrationCapture = (
  initialUrl: string
): DemonstrationCapture => {
  const actions: CapturedAction[] = [];
  const instructions: TeachingInstruction[] = [];
  const screenshots: TeachingScreenshot[] = [];
  /**
   * The bytes behind the references, addressed by content so a Demonstration
   * that photographed the same Page twice keeps one copy of it.
   */
  const screenshotBytes = new Map<ScreenshotHash, string>();
  const snapshots = new Map<AgentSnapshotId, AgentBrowserSnapshot>();
  const urlTransitions: Demonstration["urlTransitions"][number][] = [];
  const variables = new Map<string, Variable>();
  const privateValues = new Set<string>();
  const privateSelectors = new Set<string>();
  let latestSnapshot: AgentSnapshotId | null = null;
  let currentUrl = sanitizeTeachingUrl(initialUrl);
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let lastCoalesced:
    | { readonly index: number; readonly key: string }
    | undefined;

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
    snapshots.set(snapshot.snapshotId, {
      ...snapshot,
      url: sanitizeTeachingUrl(snapshot.url),
    });
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
    const previousIndex =
      input.coalesceKey !== undefined &&
      lastCoalesced?.key === input.coalesceKey
        ? lastCoalesced.index
        : undefined;
    const previous =
      previousIndex === undefined ? undefined : actions[previousIndex];
    const capturedBase = {
      action: coalescedAction(input, previous),
      actor: input.actor,
      at,
      description: input.description,
      id: previous?.id ?? input.id,
      outcome: input.outcome,
      snapshotAfter: input.snapshotAfter?.snapshotId ?? null,
      snapshotBefore: previous?.snapshotBefore ?? input.snapshotBefore,
      urlAfter: sanitizeTeachingUrl(input.urlAfter),
      urlBefore: previous?.urlBefore ?? sanitizeTeachingUrl(input.urlBefore),
    };
    const captured: CapturedAction =
      input.detail === undefined
        ? capturedBase
        : { ...capturedBase, detail: input.detail };
    // The action is what moved the Page, so the transition it caused is
    // attributed to it even when the URL was noticed only afterwards.
    transition(sanitizeTeachingUrl(input.urlBefore), at, null);
    transition(sanitizeTeachingUrl(input.urlAfter), at, captured.id);
    if (previous === undefined) {
      actions.push(captured);
    } else if (previousIndex !== undefined) {
      actions[previousIndex] = captured;
    }
    trim(actions, ACTION_LIMIT);
    lastCoalesced =
      input.coalesceKey === undefined
        ? undefined
        : { index: actions.length - 1, key: input.coalesceKey };
    return captured;
  };

  const contentOf = (
    reference: TeachingScreenshot
  ): TeachingScreenshotContent | undefined => {
    const image = screenshotBytes.get(reference.contentHash);
    return image === undefined
      ? undefined
      : { ...reference, encoding: "base64", image };
  };

  const current = (): Demonstration => ({
    actions: [...actions],
    instructions: [...instructions],
    screenshotContents: new Map(
      screenshots.flatMap((reference) => {
        const content = contentOf(reference);
        return content === undefined
          ? []
          : [[reference.contentHash, content] as const];
      })
    ),
    screenshots: [...screenshots],
    snapshots: new Map(snapshots),
    urlTransitions: [...urlTransitions],
    variables: [...variables.values()],
  });

  return {
    canRecordVariable: (variable, value, selector) => {
      const existing = variables.get(variable.name);
      return (
        (existing !== undefined || variables.size < VARIABLE_LIMIT) &&
        (privateValues.has(value) || privateValues.size < VARIABLE_LIMIT) &&
        (privateSelectors.has(selector) ||
          privateSelectors.size < VARIABLE_LIMIT) &&
        (existing === undefined ||
          (existing.runtime === variable.runtime &&
            existing.secret === variable.secret))
      );
    },
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
        variables: demonstration.variables,
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
      const contentHash = ScreenshotHash.make(
        `sha256-${createHash("sha256").update(screenshot.image, "base64").digest("hex")}`
      );
      const captured: TeachingScreenshot = {
        capturedAt: eventTime(screenshot.capturedAt),
        contentHash,
        format: screenshot.format,
        id: `screenshot-${randomUUID()}`,
        url: screenshot.url,
      };
      screenshots.push(captured);
      screenshotBytes.set(contentHash, screenshot.image);
      trim(screenshots, SNAPSHOT_LIMIT);
      // Bytes outlive nothing: once the oldest references are trimmed away,
      // the images only they named go with them.
      const live = new Set(screenshots.map((one) => one.contentHash));
      for (const hash of screenshotBytes.keys()) {
        if (!live.has(hash)) {
          screenshotBytes.delete(hash);
        }
      }
      return captured;
    },
    recordSnapshot,
    recordUrl: (url, at) =>
      transition(sanitizeTeachingUrl(url), eventTime(at), null),
    recordVariable: (variable, value, selector) => {
      variables.set(variable.name, variable);
      privateValues.add(value);
      privateSelectors.add(selector);
    },
    screenshotContent: (screenshotId) => {
      const reference = screenshots.find(({ id }) => id === screenshotId);
      return reference === undefined ? undefined : contentOf(reference);
    },
    sensitiveSelectors: () => [...privateSelectors],
    sensitiveValues: () =>
      [...privateValues].toSorted((left, right) => right.length - left.length),
  };
};
