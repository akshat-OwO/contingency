import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { teachingInstructionAuthorship } from "../../src/services/teaching-questions.ts";

it.effect(
  "check proposals need an explicit choice and preserve confirmed scan evidence",
  () =>
    Effect.gen(function* confirmChecks() {
      const proposal = {
        _tag: "scan" as const,
        reason: "The document asks for accessibility at the cart",
        scan: {
          id: "cart-a11y",
          mode: "accessibility" as const,
          phase: "start" as const,
        },
      };
      const input = {
        asking: true,
        guided: true,
        hasAttachment: false,
        instructions: [],
        origin: "agent" as const,
        proposal,
        questionId: undefined,
        replaceId: undefined,
        text: "When the cart opens",
      };
      const asked = yield* teachingInstructionAuthorship(input);
      expect(asked.dialogue).toEqual({ _tag: "question", proposal });
      const question = {
        ...asked,
        at: "2026-10-23T00:00:00Z",
        id: "q",
        target: null,
        text: input.text,
      };
      const answer = {
        ...input,
        asking: false,
        instructions: [question],
        proposal: undefined,
        questionId: "q",
      };
      expect(
        (yield* Effect.flip(teachingInstructionAuthorship(answer))).code
      ).toBe("agent_session_invalid");
      const confirmed = yield* teachingInstructionAuthorship({
        ...answer,
        decision: "confirm",
      });
      expect(confirmed.dialogue).toEqual({
        _tag: "answer",
        decision: "confirm",
        questionId: "q",
      });
      expect(confirmed.scan).toEqual(proposal.scan);
      expect(
        (yield* teachingInstructionAuthorship({
          ...answer,
          decision: "reject",
        })).scan
      ).toBeUndefined();
      expect(
        (yield* Effect.flip(
          teachingInstructionAuthorship({ ...input, guided: false })
        )).code
      ).toBe("agent_session_invalid");
    })
);
