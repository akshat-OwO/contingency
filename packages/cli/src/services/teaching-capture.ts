import { createHash, randomUUID } from "node:crypto";

import { KeyframeHash } from "@contingency/protocol";
import type {
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentSnapshotId,
  CapturedAction,
  TeachingInstruction,
  TeachingKeyframe,
  TeachingKeyframeBytes,
  TeachingProgress,
  Variable,
} from "@contingency/protocol";

import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import type { Demonstration } from "./teaching-demonstration.ts";

/** How many captured actions one Demonstration keeps. */
const ACTION_LIMIT = 2000;
/** How many relayed instructions one Demonstration keeps. */
const INSTRUCTION_LIMIT = 200;
/** How many Browser Snapshots one Demonstration keeps for evidence. */
const SNAPSHOT_LIMIT = 400;
/** How many keyframes one Demonstration keeps. */
const KEYFRAME_LIMIT = 400;
/**
 * How long one action's keyframe stands before a later moment of the same
 * gesture is worth photographing again. A coalesced gesture — typing a field,
 * scrolling a Page — is one timeline entry holding one keyframe, so without
 * this a twenty-character field would cost twenty screenshots to end up with
 * the same single image.
 */
const KEYFRAME_MIN_INTERVAL_MS = 750;
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
  /**
   * Consecutive actions carrying this key replace one captured action, so a
   * gesture the user experienced as one move — typing a field, scrolling a
   * Page — stays one entry in the semantic timeline.
   */
  readonly coalesceKey?: string | undefined;
}

/**
 * The sizes a capture ceiling is measured against, without building the
 * Demonstration. A live watchdog reads these on every tick, so they must stay
 * O(1).
 */
export interface DemonstrationCounts {
  readonly actions: number;
  readonly instructions: number;
  readonly keyframes: number;
  readonly urlTransitions: number;
}

/**
 * The in-process recorder behind one Teaching session. It keeps the
 * Demonstration — actor-attributed actions, the Browser Snapshots around them,
 * URL transitions, and relayed user instructions — for the durable Teaching
 * Recording the encoder writes. Nothing here touches the browser: the session
 * feeds it what the browser already answered.
 */
export interface DemonstrationCapture {
  /** O(1) sizes for the capture ceilings. */
  readonly counts: () => DemonstrationCounts;
  readonly current: () => Demonstration;
  readonly latestSnapshotId: () => AgentSnapshotId | null;
  /** Which gesture, if any, the next action would still coalesce into. */
  readonly openCoalesceKey: () => string | undefined;
  /** The captured action the open gesture is still extending, if any. */
  readonly openActionId: () => string | undefined;
  readonly progress: () => TeachingProgress;
  /**
   * Attach an after state to the open coalesced action, if one is still open
   * and has none. A gesture's last event is only knowable once something else
   * happens, so the session closes it when the recording stops.
   */
  readonly closeCoalescedAction: (snapshotAfter: AgentBrowserSnapshot) => void;
  /** Record one attempt and the URL change it caused, if any. */
  readonly recordAction: (input: CapturedActionInput) => CapturedAction;
  readonly recordInstruction: (
    text: string,
    at: string,
    target?: string | undefined
  ) => TeachingInstruction;
  /** Remember an observation so the next action has a `before` state. */
  readonly recordSnapshot: (snapshot: AgentBrowserSnapshot) => void;
  /**
   * Record one best-effort-masked visual observation, attributed to the action
   * whose result it photographed when there is one.
   */
  readonly recordKeyframe: (
    keyframe: AgentScreenshot,
    actionId?: string | undefined
  ) => TeachingKeyframe;
  /**
   * Whether photographing this action now would tell the reader anything the
   * keyframe it already has does not. Asked before the screenshot, so a
   * gesture the user is still performing does not pay for one per event.
   */
  readonly needsKeyframe: (actionId: string, at: string) => boolean;
  /** The bytes behind one recorded keyframe, fetched by its reference. */
  readonly keyframeBytes: (
    keyframeId: string
  ) => TeachingKeyframeBytes | undefined;
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
  /** Values that keyframe and snapshot capture must mask, longest first. */
  readonly sensitiveValues: () => readonly string[];
  /** Known private fields that keyframe capture must mask. */
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
  const keyframes: TeachingKeyframe[] = [];
  /**
   * The bytes behind the references, addressed by content so a Demonstration
   * that photographed the same Page twice keeps one copy of it.
   */
  const keyframeImages = new Map<KeyframeHash, string>();
  const snapshots = new Map<AgentSnapshotId, AgentBrowserSnapshot>();
  const urlTransitions: Demonstration["urlTransitions"][number][] = [];
  const variables = new Map<string, Variable>();
  const privateValues = new Set<string>();
  const privateSelectors = new Set<string>();
  let latestSnapshot: AgentSnapshotId | null = null;
  const startUrl = sanitizeTeachingUrl(initialUrl);
  let currentUrl = startUrl;
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

  /**
   * Give the open coalesced action the after state it never got. Only an action
   * still missing one is patched, so a gesture that already observed the Page —
   * every coalesced edit does — is left exactly as it was recorded.
   */
  const closeOpenGesture = (snapshotAfter: AgentSnapshotId | null): void => {
    const index = lastCoalesced?.index;
    const open = index === undefined ? undefined : actions[index];
    lastCoalesced = undefined;
    if (
      index === undefined ||
      open === undefined ||
      open.snapshotAfter !== null ||
      snapshotAfter === null ||
      !snapshots.has(snapshotAfter)
    ) {
      return;
    }
    actions[index] = { ...open, snapshotAfter };
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
    if (previousIndex === undefined) {
      // A different action ended any open gesture. The state it observed before
      // acting is the state the gesture left behind, so the gesture gets a real
      // after tree without the Page being snapshotted twice.
      closeOpenGesture(input.snapshotBefore);
    }
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
    let index: number;
    if (previous === undefined || previousIndex === undefined) {
      actions.push(captured);
      index = actions.length - 1;
    } else {
      actions[previousIndex] = captured;
      index = previousIndex;
    }
    const before = actions.length;
    trim(actions, ACTION_LIMIT);
    // Trimming shifts every surviving action down, so the open gesture keeps
    // pointing at itself rather than at whatever now sits last.
    const dropped = before - actions.length;
    lastCoalesced =
      input.coalesceKey === undefined || index < dropped
        ? undefined
        : { index: index - dropped, key: input.coalesceKey };
    return captured;
  };

  const contentOf = (
    reference: TeachingKeyframe
  ): TeachingKeyframeBytes | undefined => {
    const image = keyframeImages.get(reference.contentHash);
    return image === undefined
      ? undefined
      : { ...reference, encoding: "base64", image };
  };

  const current = (): Demonstration => ({
    actions: [...actions],
    instructions: [...instructions],
    keyframeBytes: new Map(
      keyframes.flatMap((reference) => {
        const content = contentOf(reference);
        return content === undefined
          ? []
          : [[reference.contentHash, content] as const];
      })
    ),
    keyframes: [...keyframes],
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
    closeCoalescedAction: (snapshotAfter) => {
      recordSnapshot(snapshotAfter);
      closeOpenGesture(snapshotAfter.snapshotId);
    },
    counts: () => ({
      actions: actions.length,
      instructions: instructions.length,
      keyframes: keyframes.length,
      urlTransitions: urlTransitions.length,
    }),
    current,
    keyframeBytes: (keyframeId) => {
      const reference = keyframes.find(({ id }) => id === keyframeId);
      return reference === undefined ? undefined : contentOf(reference);
    },
    latestSnapshotId: () => latestSnapshot,
    needsKeyframe: (actionId, at) => {
      const existing = keyframes.findLast(
        (candidate) => candidate.actionId === actionId
      );
      if (existing === undefined) {
        return true;
      }
      const since = Date.parse(at) - Date.parse(existing.capturedAt);
      return !Number.isFinite(since) || since >= KEYFRAME_MIN_INTERVAL_MS;
    },
    openActionId: () => {
      const index = lastCoalesced?.index;
      return index === undefined ? undefined : actions[index]?.id;
    },
    openCoalesceKey: () => lastCoalesced?.key,
    progress: () => ({
      actionCount: actions.length,
      instructionCount: instructions.length,
      instructions: [...instructions],
    }),
    recordAction,
    recordInstruction: (text, at, target) => {
      const instruction: TeachingInstruction = {
        at: eventTime(at),
        id: `instruction-${randomUUID()}`,
        target: target ?? null,
        text,
      };
      instructions.push(instruction);
      trim(instructions, INSTRUCTION_LIMIT);
      return instruction;
    },
    recordKeyframe: (keyframe, actionId) => {
      const contentHash = KeyframeHash.make(
        `sha256-${createHash("sha256").update(keyframe.image, "base64").digest("hex")}`
      );
      const replacing =
        actionId === undefined
          ? -1
          : keyframes.findLastIndex(
              (candidate) => candidate.actionId === actionId
            );
      const captured: TeachingKeyframe = {
        actionId: actionId ?? null,
        capturedAt: eventTime(keyframe.capturedAt),
        contentHash,
        format: keyframe.format,
        id: keyframes[replacing]?.id ?? `keyframe-${randomUUID()}`,
        url: keyframe.url,
      };
      // One recorded action keeps one keyframe: a later moment of the same
      // gesture replaces the earlier one, so the timeline shows the state the
      // user left behind rather than the one they started from.
      if (replacing === -1) {
        keyframes.push(captured);
      } else {
        keyframes[replacing] = captured;
      }
      keyframeImages.set(contentHash, keyframe.image);
      trim(keyframes, KEYFRAME_LIMIT);
      // Bytes outlive nothing: once the oldest references are trimmed away,
      // the images only they named go with them.
      const live = new Set(keyframes.map((one) => one.contentHash));
      for (const hash of keyframeImages.keys()) {
        if (!live.has(hash)) {
          keyframeImages.delete(hash);
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
    sensitiveSelectors: () => [...privateSelectors],
    sensitiveValues: () =>
      [...privateValues].toSorted((left, right) => right.length - left.length),
  };
};
