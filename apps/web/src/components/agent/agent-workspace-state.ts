import type {
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserConsoleEntry,
} from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

import type {
  FrameProjection,
  InspectState,
} from "@/components/agent/teaching-inspect-state";
import {
  emptyInspectState,
  flatFrameProjection,
} from "@/components/agent/teaching-inspect-state";
import type { TeachingClipboardAction } from "@/components/agent/teaching-recording-state";

export type AgentViewPhase =
  | "loading"
  | "empty"
  | "live"
  | "unavailable"
  | "switching";

export interface AgentViewState {
  /** What the address bar shows while the user holds the browser. */
  readonly address: string;
  readonly browserStreamError: string | undefined;
  /** What went wrong the last time the dock tried to raise a Run ceiling. */
  readonly ceilingError: string | undefined;
  /** What the page has logged while this Workspace watched it. */
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  /** What went wrong the last time this View tried to change control. */
  readonly controlError: string | undefined;
  /** A control change is in flight, so the control button is not offered twice. */
  readonly controlPending: boolean;
  /** How the frame on the canvas maps onto the Page viewport it came from. */
  readonly frameProjection: FrameProjection;
  readonly frameReady: boolean;
  /** Inspect mode over the live frame, and the comments it has attached. */
  readonly inspect: InspectState;
  /** What went wrong the last time the user navigated the browser. */
  readonly navigationError: string | undefined;
  /** A navigation is in flight, so the toolbar does not dispatch it twice. */
  readonly navigationPending: boolean;
  readonly phase: AgentViewPhase;
  /**
   * The clipboard hand-off that just succeeded, held briefly so the button
   * that performed it can confirm the copy, and `undefined` the rest of the
   * time (#214).
   */
  readonly recordingCopied: TeachingClipboardAction | undefined;
  /** What went wrong when Start or Stop was last dispatched. */
  readonly recordingError: string | undefined;
  /** A Teaching recording gesture is in flight. */
  readonly recordingPending: boolean;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: AgentSessionSnapshot | undefined;
  /** Whether the browser setup panel is showing beside the live canvas. */
  readonly setupOpen: boolean;
  /** What went wrong the last time the empty canvas tried to open a session. */
  readonly startError: string | undefined;
  /** A session is being opened from the empty canvas. */
  readonly startPending: boolean;
  readonly streamConnected: boolean;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

export const agentViewStateAtom = Atom.make<AgentViewState>({
  address: "",
  browserStreamError: undefined,
  ceilingError: undefined,
  consoleEntries: [],
  controlError: undefined,
  controlPending: false,
  frameProjection: flatFrameProjection,
  frameReady: false,
  inspect: emptyInspectState,
  navigationError: undefined,
  navigationPending: false,
  phase: "loading",
  recordingCopied: undefined,
  recordingError: undefined,
  recordingPending: false,
  selectedSessionId: undefined,
  session: undefined,
  setupOpen: false,
  startError: undefined,
  startPending: false,
  streamConnected: false,
  viewportHeight: 0,
  viewportWidth: 0,
});

/**
 * Whether the Workspace is showing the full-bleed recorded Flow Skill chrome.
 * The app header reads it so one View can own the whole viewport without a
 * second header band above its dock (#191).
 */
export const workspaceChromeAtom = Atom.make(false);

/**
 * The console keeps the most recent entries only. A page can log without
 * bound, and the Workspace holds this in memory for as long as it watches.
 */
const MAX_WORKSPACE_CONSOLE_ENTRIES = 500;

export const appendConsoleEntry = (
  entries: readonly BrowserConsoleEntry[],
  entry: BrowserConsoleEntry
): readonly BrowserConsoleEntry[] =>
  [...entries, entry].slice(-MAX_WORKSPACE_CONSOLE_ENTRIES);

/**
 * What a session is doing, in the words the Workspace uses for it. A Dry Run
 * rehearses a saved Flow Skill and an Interactive Run replays a verified one,
 * so they read as different work rather than both as "run" (#202).
 */
export const agentSessionActivityLabel = (
  session: AgentSessionSnapshot
): string => {
  if (session.activity === "teaching") {
    return "Teaching";
  }
  return session.dryRun ? "Dry Run" : "Interactive Run";
};

/**
 * How a session reads in a picker. A Teaching label is the Flow Skill name
 * alone: the capture state has its own badge in the dock, and a raw session id
 * is never a label a person can act on (#191). A Dry Run names the flow it
 * rehearses for the same reason (#202), and an Interactive Run names the flow
 * it replays, falling back to the MCP client that opened it when a Run session
 * has no Run yet (#209).
 */
export const agentSessionLabel = (session: AgentSessionSnapshot): string => {
  if (session.activity === "teaching") {
    return session.flowSkillName;
  }
  if (session.dryRun) {
    return `${session.dryRun.flowSkillName} · Dry Run`;
  }
  const name = session.run?.flowSkillName ?? session.flowSkillName;
  return `${name ?? session.clientName} · Interactive Run`;
};

/**
 * How Agent View describes control. Control is exclusive, and an agent that
 * asked for help has paused without being handed the user's control, so the
 * three states are told apart rather than collapsed into "not the agent".
 */
export interface AgentControlPresentation {
  /**
   * What the one control button does next, or `null` when there is no control
   * to exchange: Teaching is user-led for the whole Demonstration.
   */
  readonly action: string | null;
  /** Who holds the browser right now. */
  readonly holder: string;
  /** Why control changed hands, when something asked for it. */
  readonly reason: string | undefined;
}

const takeoverReason = (
  takeover: AgentSessionSnapshot["takeover"]
): string | undefined => {
  if (takeover === null) {
    return undefined;
  }
  return takeover.requestedBy === "agent"
    ? `The agent asked for help: ${takeover.reason}`
    : `You took control: ${takeover.reason}`;
};

export const agentControlPresentation = (
  session: AgentSessionSnapshot
): AgentControlPresentation => {
  const { takeover } = session;
  const reason = takeoverReason(takeover);
  if (session.activity === "teaching") {
    return {
      action: null,
      holder: "You are demonstrating this journey",
      reason: "The agent watches and never drives the browser while teaching.",
    };
  }
  if (session.controller === "user") {
    return { action: "Return control", holder: "You have control", reason };
  }
  if (session.boundary !== undefined && session.boundary !== null) {
    return {
      action: "Take control",
      holder: "The agent is waiting for confirmation",
      reason,
    };
  }
  return {
    action: "Take control",
    holder:
      session.phase === "takeover"
        ? "The agent is waiting for you"
        : "The agent has control",
    reason,
  };
};

export const agentStatusLabel = (
  session: AgentSessionSnapshot | undefined,
  streamConnected: boolean
): string => {
  if (session === undefined) {
    return "No session selected";
  }
  if (session.phase === "takeover") {
    return "Waiting for your control";
  }
  if (session.boundary !== undefined && session.boundary !== null) {
    return "Waiting for confirmation";
  }
  if (session.phase === "starting") {
    return "Starting";
  }
  if (session.phase === "completed") {
    return "Completed";
  }
  if (session.phase === "failed") {
    return "Failed";
  }
  if (session.phase === "interrupted") {
    return "Interrupted";
  }
  if (session.phase === "closed") {
    return "Closed";
  }
  return streamConnected ? "Live" : "Connecting";
};

/**
 * Which snapshot of the selected session the Workspace should hold: the one it
 * already has, or the one the sessions query just reported.
 *
 * The Workspace holds a session locally so a live stream event is not undone
 * by a poll that raced it. That hold used to be unconditional, which let the
 * dock keep offering an action the recording had already moved past: another
 * process can verify and purge a recording, and the dock's action set is
 * derived from the capture state it holds (#211).
 *
 * `updatedAt` is the server's own ordering for a session, and the Teaching
 * stream refreshes it from the recording manifest, so comparing it adopts a
 * newer lifecycle without ever rolling a newer stream event back.
 */
export const adoptSessionSnapshot = (
  held: AgentSessionSnapshot | undefined,
  polled: AgentSessionSnapshot
): AgentSessionSnapshot => {
  if (held === undefined || held.id !== polled.id) {
    return polled;
  }
  return polled.updatedAt > held.updatedAt ? polled : held;
};
