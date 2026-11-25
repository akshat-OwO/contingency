import type { AgentSessionId, OperationId } from "@contingency/protocol";
import { Effect, Option, Schema } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { Script, UserAction } from "./transcript.ts";

/**
 * The user in the Workspace: what they click, type, record, and hand back,
 * through the same Agent Session the Workspace drives. A journey on the HTTP
 * adapter records each action, so its transcript replays the user too.
 */

type Action<Tag extends UserAction["_tag"]> = Extract<
  UserAction,
  { readonly _tag: Tag }
>;

const sessionOf = (action: { readonly sessionId: string }) =>
  // SAFETY: every recorded session id was read from an Agent Session.
  action.sessionId as AgentSessionId;

const performers = {
  click: (action: Action<"click">) =>
    Effect.gen(function* clickAsTheUser() {
      const session = yield* AgentSession;
      for (const eventType of ["mousePressed", "mouseReleased"] as const) {
        yield* session.sendInput(sessionOf(action), {
          button: "left",
          clickCount: 1,
          eventType,
          type: "input_mouse",
          x: action.x,
          y: action.y,
        });
      }
    }),
  "return-control": (action: Action<"return-control">) =>
    AgentSession.use((session) => session.returnControl(sessionOf(action))),
  "start-recording": (action: Action<"start-recording">) =>
    AgentSession.use((session) =>
      session.startTeachingRecording(sessionOf(action), action.operationId)
    ),
  "stop-recording": (action: Action<"stop-recording">) =>
    AgentSession.use((session) =>
      session.stopTeachingRecording(sessionOf(action), action.operationId)
    ),
  "supply-variable": (action: Action<"supply-variable">) =>
    AgentSession.use((session) =>
      session.supplyDryRunVariable(sessionOf(action), action.name, action.value)
    ),
  takeover: (action: Action<"takeover">) =>
    AgentSession.use((session) =>
      session.takeover(sessionOf(action), action.reason)
    ),
  type: (action: Action<"type">) =>
    Effect.gen(function* typeAsTheUser() {
      const session = yield* AgentSession;
      for (const character of action.text) {
        yield* session.sendInput(sessionOf(action), {
          eventType: "keyDown",
          key: character,
          text: character,
          type: "input_keyboard",
        });
        yield* session.sendInput(sessionOf(action), {
          eventType: "keyUp",
          key: character,
          type: "input_keyboard",
        });
      }
    }),
};

/** Performs one recorded action, as a replay does. */
export const performUserAction = (action: UserAction) => {
  switch (action._tag) {
    case "click": {
      return performers.click(action);
    }
    case "return-control": {
      return performers["return-control"](action);
    }
    case "start-recording": {
      return performers["start-recording"](action);
    }
    case "stop-recording": {
      return performers["stop-recording"](action);
    }
    case "supply-variable": {
      return performers["supply-variable"](action);
    }
    case "takeover": {
      return performers.takeover(action);
    }
    case "type": {
      return performers.type(action);
    }
    default: {
      return Effect.die(action satisfies never);
    }
  }
};

/** Records an action when the journey records its transcript. */
const record = (action: UserAction) =>
  Effect.gen(function* recordUserAction() {
    const script = yield* Effect.serviceOption(Script);
    if (Option.isSome(script) && script.value.adapter === "http") {
      const { recorder } = script.value;
      // A supplied value is the user's, never the agent's, so the transcript
      // holds a token the replaying test fills in.
      if (action._tag === "supply-variable") {
        recorder.environment(
          `variable${action.name.replaceAll(/[^A-Za-z0-9]/gu, "")}`,
          action.value
        );
      }
      recorder.user(
        Schema.decodeUnknownSync(UserAction)(recorder.tokenize(action))
      );
    }
  });

/** Performs an action as the user, recording it first. */
const asUser = <A extends UserAction, B, E, R>(
  action: A,
  perform: (action: A) => Effect.Effect<B, E, R>
) => Effect.andThen(record(action), perform(action));

const minted = (operationId: OperationId | undefined) =>
  operationId === undefined
    ? Script.useSync((script) => script.mint())
    : Effect.succeed(operationId);

export const User = {
  /** Presses and releases the left button at a point of the page. */
  click: (sessionId: string, at: { readonly x: number; readonly y: number }) =>
    asUser({ _tag: "click", sessionId, x: at.x, y: at.y }, performers.click),
  /** Hands control back to the agent after a Takeover. */
  returnControl: (sessionId: string) =>
    asUser({ _tag: "return-control", sessionId }, performers["return-control"]),
  /** Presses Record in a Teaching session. */
  startRecording: (sessionId: string, operationId?: OperationId) =>
    Effect.flatMap(minted(operationId), (id) =>
      asUser(
        { _tag: "start-recording", operationId: id, sessionId },
        performers["start-recording"]
      )
    ),
  /** Presses Stop in a Teaching session. */
  stopRecording: (sessionId: string, operationId?: OperationId) =>
    Effect.flatMap(minted(operationId), (id) =>
      asUser(
        { _tag: "stop-recording", operationId: id, sessionId },
        performers["stop-recording"]
      )
    ),
  /** Types a runtime Variable's value into the Workspace's Variable prompt. */
  supplyVariable: (sessionId: string, name: string, value: string) =>
    asUser(
      { _tag: "supply-variable", name, sessionId, value },
      performers["supply-variable"]
    ),
  /** Takes control of the browser from the agent. */
  takeover: (sessionId: string, reason: string) =>
    asUser({ _tag: "takeover", reason, sessionId }, performers.takeover),
  /** Types text one key at a time into whatever has focus. */
  type: (sessionId: string, text: string) =>
    asUser({ _tag: "type", sessionId, text }, performers.type),
};
