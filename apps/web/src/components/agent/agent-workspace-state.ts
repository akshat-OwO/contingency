import type {
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserAgentPointer,
  BrowserBotProtectionBlock,
  BrowserConsoleEntry,
} from "@contingency/protocol";
import { isLiveAgentSessionPhase } from "@contingency/protocol";
import { Atom } from "effect/reactivity";

import type {
  FrameProjection,
  InspectState,
} from "@/components/agent/teaching-inspect-state";
import {
  emptyInspectState,
  flatFrameProjection,
} from "@/components/agent/teaching-inspect-state";

export type AgentViewPhase =
  | "loading"
  | "empty"
  | "live"
  | "unavailable"
  | "switching";

export interface AgentViewState {
  /** What the address bar shows while the user holds the browser. */
  readonly address: string;
  /** Where the agent last pointed, for the cursor drawn over the frame. */
  readonly agentPointer: BrowserAgentPointer | undefined;
  /** The latest request the site's bot protection refused, until dismissed. */
  readonly botProtectionBlock: BrowserBotProtectionBlock | undefined;
  readonly browserStreamError: string | undefined;
  /** What the page has logged while this Workspace watched it. */
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  /** How the frame on the canvas maps onto the Page viewport it came from. */
  readonly frameProjection: FrameProjection;
  readonly frameReady: boolean;
  /** Inspect mode over the live frame, and the comments it has attached. */
  readonly inspect: InspectState;
  /** The shown tab is loading, so the device bar offers Stop loading. */
  readonly pageLoading: boolean;
  readonly phase: AgentViewPhase;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: AgentSessionSnapshot | undefined;
  readonly streamConnected: boolean;
  /**
   * The `?session=` id that did not resolve when this process owns no session.
   */
  readonly unresolvedSessionId: string | undefined;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

export const agentViewStateAtom = Atom.make<AgentViewState>({
  address: "",
  agentPointer: undefined,
  botProtectionBlock: undefined,
  browserStreamError: undefined,
  consoleEntries: [],
  frameProjection: flatFrameProjection,
  frameReady: false,
  inspect: emptyInspectState,
  pageLoading: false,
  phase: "loading",
  selectedSessionId: undefined,
  session: undefined,
  streamConnected: false,
  unresolvedSessionId: undefined,
  viewportHeight: 0,
  viewportWidth: 0,
});

/**
 * A recording's unfinished comment, kept while the Workspace is unmounted so
 * a visit to the Flows page (#755) and Back do not lose it. `url` is the Page
 * it was written on: element references and pins hold only there.
 */
export interface SavedTeachingInspect {
  readonly inspect: InspectState;
  readonly recordingId: string;
  readonly url: string;
}

export const savedTeachingInspectAtom = Atom.make<SavedTeachingInspect | null>(
  null
).pipe(Atom.keepAlive);

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
 * rehearses a saved Flow and an Interactive Run replays a verified one,
 * so they read as different work rather than both as "run" (#202).
 */
export const agentSessionActivityLabel = (
  session: AgentSessionSnapshot
): string => {
  if (session.activity === "teaching") {
    return session.origin === "guided-run" ? "Guided Run" : "Teaching";
  }
  return session.dryRun ? "Dry Run" : "Interactive Run";
};

/**
 * How a session reads in a picker. A Teaching label is the Flow name
 * alone: the capture state has its own badge in the dock, and a raw session id
 * is never a label a person can act on (#191). A Dry Run names the flow it
 * rehearses for the same reason (#202), and an Interactive Run names the flow
 * it replays, falling back to the MCP client that opened it when a Run session
 * has no Run yet (#209).
 */
export const agentSessionLabel = (session: AgentSessionSnapshot): string => {
  if (session.activity === "teaching") {
    return session.origin === "guided-run"
      ? `${session.flowName} · Guided Run`
      : session.flowName;
  }
  if (session.dryRun) {
    return `${session.dryRun.flowName} · Dry Run`;
  }
  const name =
    session.run !== null && "schemaVersion" in session.run
      ? session.run.title
      : (session.run?.flowName ?? session.flowName);
  return `${name ?? session.clientName} · Interactive Run`;
};

/**
 * Whether a session is an Interactive Run that has a Run behind it. Only such
 * a session leaves a Run Summary the Workspace can show once it ends; a Dry
 * Run reports to its Teaching session instead.
 */
export const isInteractiveRunSession = (
  session: AgentSessionSnapshot
): boolean =>
  session.activity === "run" &&
  (session.dryRun ?? null) === null &&
  session.run !== null;

/**
 * The held snapshot of an Interactive Run that has left the live session list.
 * The list holds live sessions only, so leaving it means the Run ended even
 * when the Workspace never saw the closing snapshot arrive.
 */
export const endedRunSnapshot = (
  session: AgentSessionSnapshot
): AgentSessionSnapshot =>
  isLiveAgentSessionPhase(session.phase)
    ? { ...session, phase: "closed" }
    : session;

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

/** The same control gestures on browser, Android, and iOS docks. */
export const controlState = (
  controller: "agent" | "user",
  requested = false
): Pick<AgentControlPresentation, "action" | "holder"> => {
  if (controller === "user") {
    return { action: "Return control", holder: "You have control" };
  }
  return requested
    ? {
        action: "Take over",
        holder: "The agent is asking you to take over",
      }
    : { action: "Take control", holder: "The agent has control" };
};

const takeoverReason = (
  takeover: AgentSessionSnapshot["takeover"]
): string | undefined => {
  if (takeover === null) {
    return undefined;
  }
  if (takeover.requestedBy === "agent") {
    return `The agent asked for help: ${takeover.reason}`;
  }
  // A default reason only restates the badge; a user's own words add to it.
  return /^(?:the user|you) took control\b/iu.test(takeover.reason.trim())
    ? undefined
    : `You took control: ${takeover.reason}`;
};

export const agentControlPresentation = (
  session: AgentSessionSnapshot
): AgentControlPresentation => {
  const { takeover } = session;
  const reason = takeoverReason(takeover);
  if (
    session.activity === "teaching" &&
    !(
      session.origin === "guided-run" &&
      session.captureState._tag === "recording"
    )
  ) {
    if (session.controller === "agent") {
      return {
        action: null,
        holder: "The agent is preparing the browser",
        reason:
          "It hands you control before recording. It cannot drive the browser after that.",
      };
    }
    return {
      action: null,
      holder: "You are demonstrating this journey",
      reason: "The agent watches and never drives the browser while teaching.",
    };
  }
  // An ended session keeps who held the browser last, but control no longer
  // changes hands (#268).
  if (!isLiveAgentSessionPhase(session.phase)) {
    return {
      action: null,
      holder:
        session.controller === "user"
          ? "You had control"
          : "The agent had control",
      reason: undefined,
    };
  }
  if (session.controller === "user") {
    return { ...controlState(session.controller), reason };
  }
  if (session.phase === "takeover") {
    return { ...controlState(session.controller, true), reason };
  }
  if (session.boundary !== undefined && session.boundary !== null) {
    return {
      action: "Take control",
      holder: "The agent is waiting for confirmation",
      reason,
    };
  }
  return {
    ...controlState(session.controller),
    reason,
  };
};

export const hasExecutionBoundaryNotice = (session: AgentSessionSnapshot) =>
  session.boundary !== null && session.boundary !== undefined;

/** The status sentence while the agent waits on an answer from the user. */
export const WAITING_ON_YOU_SENTENCE =
  "The agent is waiting on you. Answer the request to let it continue; nothing runs until you do.";

/** Whether a Guided recording still has a question nobody has answered. */
const hasOpenGuidedQuestion = (session: AgentSessionSnapshot): boolean => {
  if (
    session.activity !== "teaching" ||
    session.origin !== "guided-run" ||
    session.captureState._tag !== "recording"
  ) {
    return false;
  }
  const { instructions } = session.teaching;
  const answered = new Set(
    instructions.flatMap((item) =>
      item.dialogue?._tag === "answer" ? [item.dialogue.questionId] : []
    )
  );
  return instructions.some(
    (item) => item.dialogue?._tag === "question" && !answered.has(item.id)
  );
};

/**
 * Whether the agent is waiting on an answer only the user can give: an open
 * Execution Boundary, any Variable request (Setup, runtime, Prerequisite,
 * Example or Dry Run), or an unanswered Guided Run question. The status chip
 * then reads `Needs you`, whatever the session was doing (#753). A Takeover
 * Variable is not here: it is the user's own tool while they drive, and the
 * agent waits on nothing through it.
 */
export const waitsOnUser = (session: AgentSessionSnapshot): boolean => {
  if (!isLiveAgentSessionPhase(session.phase)) {
    return false;
  }
  if (
    hasExecutionBoundaryNotice(session) ||
    (session.pendingDecisions ?? []).some(
      ({ kind }) => kind === "supply_variable"
    )
  ) {
    return true;
  }
  if (session.activity === "run") {
    return (session.dryRun?.variables ?? []).some(({ supplied }) => !supplied);
  }
  return (
    (session.controller === "agent" &&
      session.captureState._tag === "setup" &&
      (session.setupVariables ?? []).some(
        ({ status }) => status === "requested"
      )) ||
    hasOpenGuidedQuestion(session)
  );
};

/**
 * Whether the held session waits on the user, for the status chip. A
 * boolean, so the chip re-renders only when the answer changes, not on every
 * frame or pointer update the view state carries.
 */
export const sessionWaitsOnUserAtom = agentViewStateAtom.pipe(
  Atom.map(({ session }) => session !== undefined && waitsOnUser(session))
);

/**
 * Whether the comment card is open, for the Comment button's
 * `aria-expanded`. A boolean for the same reason as above.
 */
export const commentComposerOpenAtom = agentViewStateAtom.pipe(
  Atom.map(({ inspect }) => inspect.composing)
);

/**
 * A Guided recording's status sentence. The badge already names who holds
 * the browser, so the sentence says what comes next, or why the agent asked.
 */
export const guidedControlSentence = (
  session: AgentSessionSnapshot
): string => {
  const { action, reason } = agentControlPresentation(session);
  if (waitsOnUser(session)) {
    return WAITING_ON_YOU_SENTENCE;
  }
  if (session.controller === "user") {
    return (
      reason ??
      "Capture continues while you drive. Return control when you're done."
    );
  }
  if (action === "Take over") {
    return reason ?? "The agent is asking you to take over.";
  }
  return (
    reason ?? "The agent is following the document. Take control at any time."
  );
};

export const agentStatusLabel = (
  session: AgentSessionSnapshot | undefined,
  streamConnected: boolean
): string => {
  if (session === undefined) {
    return "No session selected";
  }
  // Any open request outranks who holds the browser: it is what the person
  // has to do next (#753).
  if (waitsOnUser(session)) {
    return "Needs you";
  }
  if (session.phase === "takeover") {
    return session.controller === "agent"
      ? "Takeover requested"
      : "You have control";
  }
  if (session.phase === "starting") {
    return "Starting";
  }
  if (session.phase === "failed") {
    return "Failed";
  }
  if (session.phase === "interrupted") {
    return "Interrupted";
  }
  // A Run that ended without failing reads `Ended`; its verdict is the Run
  // Summary's, not the chip's (#757).
  if (session.phase === "completed" || session.phase === "closed") {
    return "Ended";
  }
  if (!streamConnected) {
    return "Connecting";
  }
  // A Dry Run rehearses a Flow; any other live Run is the agent driving it.
  return session.activity === "run" &&
    session.dryRun !== null &&
    session.dryRun !== undefined
    ? "Rehearsing"
    : "Agent driving";
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

/** Follow a rehearsal by recording identity, regardless of session list order. */
export const relatedWorkspaceSession = (
  held: AgentSessionSnapshot | undefined,
  sessions: readonly AgentSessionSnapshot[]
): AgentSessionSnapshot | undefined => {
  if (held?.activity === "teaching") {
    const teaching = sessions.find((session) => session.id === held.id) ?? held;
    if (
      teaching.activity === "teaching" &&
      teaching.captureState._tag === "dry-running"
    ) {
      const { dryRunSessionId } = teaching.captureState;
      return sessions.find((session) => session.id === dryRunSessionId);
    }
  }
  if (held?.activity === "run" && held.dryRun !== null) {
    const { recordingId } = held.dryRun;
    const teaching = sessions.find(
      (session) =>
        session.activity === "teaching" && session.recordingId === recordingId
    );
    if (
      teaching?.activity === "teaching" &&
      (!sessions.some(
        (session) =>
          session.id === held.id && isLiveAgentSessionPhase(session.phase)
      ) ||
        teaching.captureState._tag === "dry-run-passed" ||
        teaching.captureState._tag === "dry-run-failed")
    ) {
      return teaching;
    }
  }
  return undefined;
};
