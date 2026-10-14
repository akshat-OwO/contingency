import { FlowSkillName, OperationId } from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { applyCommand, FIXTURE_SELECTION, fixtureSnapshot } from "./fixtures";
import type { PrototypeState } from "./fixtures";
import type { AndroidDockGesture } from "./presentation";

/**
 * One prototype's session, opened on the chosen state. Commands move it the
 * way the service would, so every button in a prototype does something.
 */
export const usePrototypeSession = (state: PrototypeState) => {
  const [sessionAtom] = useState(() =>
    Atom.make<AndroidWorkspaceSnapshot | null>(fixtureSnapshot(state))
  );
  const [session, setSession] = useAtom(sessionAtom);
  const dispatch = (command: AndroidWorkspaceCommand) => {
    setSession((current) => applyCommand(current, command));
  };
  return [session, dispatch] as const;
};

let operations = 0;
export const nextOperationId = () => {
  operations += 1;
  return OperationId.make(`prototype-${operations}`);
};

/** A command's mutation fields for the selected session. */
export const mutation = (session: AndroidWorkspaceSnapshot) => ({
  operationId: nextOperationId(),
  sessionId: session.id,
});

type Dispatch = (command: AndroidWorkspaceCommand) => void;
type InputAction = Extract<
  AndroidWorkspaceCommand,
  { readonly _tag: "input" }
>["action"];

/** Runs the dock's one primary gesture as the command it names. */
export const performGesture = (
  gesture: AndroidDockGesture,
  session: AndroidWorkspaceSnapshot,
  dispatch: Dispatch
) => {
  const fields = mutation(session);
  switch (gesture) {
    case "prepare":
    case "recover": {
      dispatch({ _tag: gesture, ...fields });
      return;
    }
    case "start-recording":
    case "stop-recording": {
      dispatch({
        _tag: "record",
        ...fields,
        start: gesture === "start-recording",
      });
      return;
    }
    case "take-control":
    case "return-control": {
      dispatch({
        _tag: "control",
        ...fields,
        controller: gesture === "take-control" ? "user" : "agent",
      });
      return;
    }
    default: {
      dispatch({
        _tag: "flow-decision",
        ...fields,
        decision: gesture === "verify-flow" ? "verify" : "retry-cleanup",
      });
    }
  }
};

/** Sends one semantic action against the latest observation. */
export const deviceInput = (
  session: AndroidWorkspaceSnapshot,
  dispatch: Dispatch,
  action: InputAction
) =>
  dispatch({
    _tag: "input",
    ...mutation(session),
    action,
    observationId: session.observation?.id ?? "none",
  });

/** Answers a Run Environment Permission. */
export const decide = (
  session: AndroidWorkspaceSnapshot,
  dispatch: Dispatch,
  decisionId: string,
  allow: boolean
) => dispatch({ _tag: "decide", ...mutation(session), allow, decisionId });

/** Opens a Teaching session on the selection a setup sheet collected. */
export const startWithSelection = (
  dispatch: Dispatch,
  selection: AndroidWorkspaceCommand extends infer Command
    ? Command extends { readonly _tag: "start"; readonly selection: infer S }
      ? S
      : never
    : never
) =>
  dispatch({
    _tag: "start",
    flowSkillName: FlowSkillName.make("checkout"),
    kind: "teaching",
    operationId: nextOperationId(),
    recordingId: null,
    selection,
  });

/** Opens the fixture Teaching session, as an agent or a setup form would. */
export const startSession = (dispatch: Dispatch, helper: boolean) =>
  dispatch({
    _tag: "start",
    flowSkillName: FlowSkillName.make("checkout"),
    kind: "teaching",
    operationId: nextOperationId(),
    recordingId: null,
    selection: {
      ...FIXTURE_SELECTION,
      helperConsent: helper ? "install" : "none",
    },
  });
