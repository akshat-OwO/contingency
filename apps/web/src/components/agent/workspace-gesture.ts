import type { AgentSessionId } from "@contingency/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import type { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

/**
 * One dispatch of a Workspace gesture: the RPC call and whatever the View
 * applies once it answers. It fails with the sentence the Workspace shows, so
 * a refusal is formatted once, where the gesture knows what it was.
 */
export type GestureRun = Effect.Effect<void, string>;

/*
  The run travels inside an object because the atom setter reads a function
  argument as an updater.
*/
interface GestureRequest {
  readonly run: GestureRun;
}

type GestureAtom = Atom.AtomResultFn<GestureRequest, void, string>;

/*
  A gesture outlives the View that dispatched it. Its RPC has already reached
  the server, so interrupting it on a switch or an unmount would only lose the
  outcome: a Takeover that failed while the user looked at another session
  would read as one that never happened.
*/
const gestureAtom = (): GestureAtom =>
  Atom.keepAlive(Atom.fn((request: GestureRequest) => request.run));

/**
 * One gesture's state per Agent Session. A gesture dispatched for one session
 * can never mark another as pending or show it a failure, however the
 * selection moves while the gesture is in flight.
 */
const sessionGestureFamily = () =>
  Atom.family((_sessionId: AgentSessionId) => gestureAtom());

/** Take control and Return control. */
export const controlGestureAtom = sessionGestureFamily();
/** The Teaching dock's lifecycle actions, from Start to Cleanup retry. */
export const recordingGestureAtom = sessionGestureFamily();
/** Back, forward, reload, and address-bar navigation during Takeover. */
export const navigationGestureAtom = sessionGestureFamily();
/** Saving a Teaching comment as an instruction on the recording. */
export const commentGestureAtom = sessionGestureFamily();
/** Opening a Teaching session from the empty canvas, which has no session yet. */
export const sessionStartGestureAtom = gestureAtom();

/** What stands in for a session's gesture while no session is selected. */
const unselectedGestureAtom = gestureAtom();

export const sessionGesture = (
  family: (sessionId: AgentSessionId) => GestureAtom,
  sessionId: AgentSessionId | undefined
): GestureAtom =>
  sessionId === undefined ? unselectedGestureAtom : family(sessionId);

export interface WorkspaceGesture {
  /**
   * Starts the gesture unless the same gesture is already in flight, and says
   * whether it started. Other gestures are never blocked by this one.
   */
  readonly dispatch: (run: GestureRun) => boolean;
  /**
   * Why the last attempt failed. It stays until the gesture is tried again,
   * and a retry clears it as soon as it starts.
   */
  readonly error: string | undefined;
  readonly pending: boolean;
}

export const useWorkspaceGesture = (atom: GestureAtom): WorkspaceGesture => {
  const registry = useContext(RegistryContext);
  const result = useAtomValue(atom);
  return {
    dispatch: (run) => {
      // Read at dispatch rather than at render, so a double click that lands
      // before the next render still sends one request.
      if (registry.get(atom).waiting) {
        return false;
      }
      registry.set(atom, { run });
      return true;
    },
    error: result.waiting
      ? undefined
      : Option.getOrUndefined(AsyncResult.error(result)),
    pending: result.waiting,
  };
};
