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
  readonly browserStreamError: string | undefined;
  readonly frameReady: boolean;
  readonly phase: AgentViewPhase;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: AgentSessionSnapshot | undefined;
  readonly streamConnected: boolean;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

export const agentViewStateAtom = Atom.make<AgentViewState>({
  browserStreamError: undefined,
  frameReady: false,
  phase: "loading",
  selectedSessionId: undefined,
  session: undefined,
  streamConnected: false,
  viewportHeight: 0,
  viewportWidth: 0,
});

export const agentSessionLabel = (session: AgentSessionSnapshot): string =>
  `${session.clientName} · ${session.activity} · ${session.id}`;

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
