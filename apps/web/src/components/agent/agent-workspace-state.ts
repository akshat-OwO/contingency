import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

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
  /** What went wrong the last time this View tried to change control. */
  readonly controlError: string | undefined;
  /** A control change is in flight, so the control button is not offered twice. */
  readonly controlPending: boolean;
  readonly frameReady: boolean;
  /** What went wrong the last time the user navigated the browser. */
  readonly navigationError: string | undefined;
  /** A navigation is in flight, so the toolbar does not dispatch it twice. */
  readonly navigationPending: boolean;
  readonly phase: AgentViewPhase;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: AgentSessionSnapshot | undefined;
  readonly streamConnected: boolean;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

export const agentViewStateAtom = Atom.make<AgentViewState>({
  address: "",
  browserStreamError: undefined,
  controlError: undefined,
  controlPending: false,
  frameReady: false,
  navigationError: undefined,
  navigationPending: false,
  phase: "loading",
  selectedSessionId: undefined,
  session: undefined,
  streamConnected: false,
  viewportHeight: 0,
  viewportWidth: 0,
});

export const agentSessionLabel = (session: AgentSessionSnapshot): string =>
  `${session.clientName} · ${session.activity} · ${session.id}`;

/**
 * How Agent View describes control. Control is exclusive, and an agent that
 * asked for help has paused without being handed the user's control, so the
 * three states are told apart rather than collapsed into "not the agent".
 */
export interface AgentControlPresentation {
  /** What the one control button does next. */
  readonly action: string;
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
  if (session.controller === "user") {
    return { action: "Return control", holder: "You have control", reason };
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
