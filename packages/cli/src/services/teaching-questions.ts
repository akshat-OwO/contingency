import type {
  GuidedRunCheckProposal,
  GuidedRunCheckDecision,
  TeachingInstruction,
} from "@contingency/protocol";
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

const validateChoicePlacement = Effect.fn("validateChoicePlacement")(
  function* validateChoicePlacement(input: {
    readonly asking: boolean;
    readonly proposal?: GuidedRunCheckProposal | undefined;
    readonly decision?: GuidedRunCheckDecision | undefined;
    readonly questionId: string | undefined;
  }) {
    if (
      (input.proposal !== undefined && !input.asking) ||
      (input.decision !== undefined &&
        (input.asking || input.questionId === undefined))
    ) {
      return yield* Effect.fail(
        agentSessionError(
          "agent_session_invalid",
          "Propose a check in a question and confirm or reject it with its questionId."
        )
      );
    }
  }
);

const confirmedEvidence = Effect.fn("confirmedEvidence")(
  function* confirmedEvidence(
    instructions: readonly TeachingInstruction[],
    questionId: string,
    decision: GuidedRunCheckDecision | undefined,
    text: string
  ) {
    const question = instructions.find((item) => item.id === questionId);
    const proposal =
      question?.dialogue?._tag === "question"
        ? question.dialogue.proposal
        : undefined;
    if ((proposal === undefined) !== (decision === undefined)) {
      return yield* Effect.fail(
        agentSessionError(
          "agent_session_invalid",
          "A check proposal requires an explicit confirm or reject decision; ordinary questions take a text answer."
        )
      );
    }
    const confirmed = decision === "confirm" ? proposal : undefined;
    return {
      attachments:
        confirmed?._tag === "browser"
          ? [
              {
                candidate: confirmed.check,
                id: confirmed.check.id,
                label: question?.text ?? text,
                requirement: confirmed.check,
              },
            ]
          : undefined,
      scan: confirmed?._tag === "scan" ? confirmed.scan : undefined,
    };
  }
);

/** Validated inside the session mutation lock, before appending either half. */
export const teachingInstructionAuthorship = Effect.fn(
  "teachingInstructionAuthorship"
)(function* teachingInstructionAuthorship(input: {
  readonly asking: boolean;
  readonly proposal?: GuidedRunCheckProposal | undefined;
  readonly decision?: GuidedRunCheckDecision | undefined;
  readonly questionId: string | undefined;
  readonly replaceId: string | undefined;
  readonly hasAttachment: boolean;
  readonly hasRequirement?: boolean;
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
  yield* validateChoicePlacement(input);
  if (input.guided && input.hasRequirement) {
    return yield* Effect.fail(
      agentSessionError(
        "agent_session_invalid",
        "Guided Run checks require a proposal and explicit confirmation."
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
      dialogue:
        input.proposal === undefined
          ? { _tag: "question" as const }
          : { _tag: "question" as const, proposal: input.proposal },
    };
  }
  if (questionId === undefined) {
    return yield* Effect.die("An answer needs a question id");
  }
  yield* requireOpenQuestion(instructions, questionId);
  const evidence = yield* confirmedEvidence(
    instructions,
    questionId,
    input.decision,
    input.text
  );
  return {
    actor: input.origin === "agent" ? ("agent" as const) : ("user" as const),
    attachments: evidence.attachments,
    description:
      input.origin === "agent"
        ? "The agent relayed the user's answer"
        : "The user answered a question",
    dialogue:
      input.decision === undefined
        ? { _tag: "answer" as const, questionId }
        : { _tag: "answer" as const, decision: input.decision, questionId },
    scan: evidence.scan,
  };
});
