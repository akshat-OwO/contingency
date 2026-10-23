import type { TeachingInstruction } from "@contingency/protocol";
import { Effect } from "effect";

import { agentSessionError } from "./agent-session-error.ts";

const requireOpenQuestion = (
  instructions: readonly TeachingInstruction[],
  questionId: string
) => {
  const question = instructions.find((item) => item.id === questionId);
  const answered = instructions.some(
    (item) =>
      item.dialogue?._tag === "answer" &&
      item.dialogue.questionId === questionId
  );
  return question?.dialogue?._tag === "question" && !answered
    ? Effect.void
    : Effect.fail(
        agentSessionError(
          "agent_session_conflict",
          "This question is unknown or already answered."
        )
      );
};

/** Validated inside the session mutation lock, before appending either half. */
export const teachingInstructionAuthorship = Effect.fn(
  "teachingInstructionAuthorship"
)(function* teachingInstructionAuthorship(input: {
  readonly asking: boolean;
  readonly questionId: string | undefined;
  readonly replaceId: string | undefined;
  readonly hasAttachment: boolean;
  readonly instructions: readonly TeachingInstruction[];
  readonly guided: boolean;
  readonly origin: "agent" | "workspace";
  readonly text: string;
}) {
  const { instructions, questionId, asking } = input;
  if (
    input.replaceId !== undefined &&
    instructions.some(
      (item) => item.id === input.replaceId && item.dialogue !== undefined
    )
  ) {
    return yield* Effect.fail(
      agentSessionError(
        "agent_session_invalid",
        "Question and answer evidence cannot be replaced."
      )
    );
  }
  if (!asking && questionId === undefined) {
    return {
      actor: "user" as const,
      description: "The user gave an instruction",
    };
  }
  if (!input.guided) {
    return yield* Effect.fail(
      agentSessionError(
        "agent_session_invalid",
        "Questions require a Guided Run."
      )
    );
  }
  if (input.hasAttachment || input.replaceId !== undefined) {
    return yield* Effect.fail(
      agentSessionError(
        "agent_session_invalid",
        "A question or answer cannot replace or attach to another Instruction."
      )
    );
  }
  if (input.text.trim().length === 0) {
    return yield* Effect.fail(
      agentSessionError(
        "agent_session_invalid",
        "A question or answer needs text."
      )
    );
  }
  if (asking) {
    if (
      instructions.filter((item) => item.dialogue?._tag === "question")
        .length >= 50
    ) {
      return yield* Effect.fail(
        agentSessionError(
          "agent_session_invalid",
          "A Guided Run supports up to 50 questions."
        )
      );
    }
    return {
      actor: "agent" as const,
      description: "The agent asked a question",
      dialogue: { _tag: "question" as const },
    };
  }
  if (questionId === undefined) {
    return yield* Effect.die("An answer needs a question id");
  }
  yield* requireOpenQuestion(instructions, questionId);
  return {
    actor: input.origin === "agent" ? ("agent" as const) : ("user" as const),
    description:
      input.origin === "agent"
        ? "The agent relayed the user's answer"
        : "The user answered a question",
    dialogue: { _tag: "answer" as const, questionId },
  };
});
