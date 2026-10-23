import { OperationId } from "@contingency/protocol";
import type {
  AgentSessionId,
  AgentSessionSnapshot,
  TeachingInstruction,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { failureMessage } from "@/lib/failure-message";
import { retainedFamily } from "@/lib/retained-state";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

interface AnswerDraft {
  readonly error: string;
  readonly operationId: OperationId | null;
  readonly pending: boolean;
  readonly text: string;
}

const emptyAnswer: AnswerDraft = {
  error: "",
  operationId: null,
  pending: false,
  text: "",
};
const questionAnswerState = retainedFamily(emptyAnswer);
const answerKey = (sessionId: AgentSessionId, questionId: string) =>
  JSON.stringify([sessionId, questionId]);

const AnsweredQuestion = ({
  question,
  answer,
  sessionId,
}: {
  readonly question: TeachingInstruction;
  readonly answer: TeachingInstruction;
  readonly sessionId: AgentSessionId;
}) => {
  const [draft, setDraft] = useAtom(
    questionAnswerState(answerKey(sessionId, question.id))
  );
  useEffect(() => {
    if (draft !== emptyAnswer) {
      setDraft(emptyAnswer);
    }
  }, [draft, setDraft]);
  return (
    <div className="text-sm">
      <p className="font-medium">{question.text}</p>
      <p>{answer.text}</p>
      <p className="text-muted-foreground text-xs">
        {answer.actor === "agent"
          ? "User answer relayed by agent"
          : "Answered by user"}
      </p>
    </div>
  );
};

const QuestionAnswer = ({
  question,
  sessionId,
  closed,
}: {
  readonly question: TeachingInstruction;
  readonly sessionId: AgentSessionId;
  readonly closed: boolean;
}) => {
  const { agentTeachingInstructionRecordMutation } = useRpcDependencies();
  const answer = useAtomSet(agentTeachingInstructionRecordMutation, {
    mode: "promise",
  });
  const [state, setState] = useAtom(
    questionAnswerState(answerKey(sessionId, question.id))
  );
  const submit = async () => {
    if (
      state.pending ||
      state.text.trim() === "" ||
      state.operationId === null
    ) {
      return;
    }
    setState((current) => ({ ...current, error: "", pending: true }));
    try {
      await answer({
        payload: {
          operationId: state.operationId,
          questionId: question.id,
          sessionId,
          text: state.text,
        },
      });
      setState(emptyAnswer);
    } catch (error) {
      setState((current) => ({
        ...current,
        error: failureMessage(error, "Could not answer this question."),
        pending: false,
      }));
    }
  };
  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        await submit();
      }}
    >
      <label className="block text-sm font-medium" htmlFor={question.id}>
        {question.text}
      </label>
      {closed ? (
        <p className="text-muted-foreground text-sm">
          Unanswered when recording stopped
        </p>
      ) : (
        <>
          <Textarea
            id={question.id}
            aria-label={`Answer: ${question.text}`}
            value={state.text}
            disabled={state.pending}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                operationId: OperationId.make(crypto.randomUUID()),
                text: event.target.value,
              }))
            }
          />
          <Button
            size="sm"
            type="submit"
            disabled={state.pending || state.text.trim() === ""}
          >
            Send answer
          </Button>
        </>
      )}
      {state.error === "" ? null : (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
};

export const GuidedRunQuestions = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  if (session.activity !== "teaching" || session.origin !== "guided-run") {
    return null;
  }
  const { instructions } = session.teaching;
  const questions = instructions.filter(
    (item) => item.dialogue?._tag === "question"
  );
  if (questions.length === 0) {
    return null;
  }
  return (
    <section aria-label="Guided Run questions" className="space-y-3">
      <h2 className="text-sm font-medium">Guided Run questions</h2>
      {questions.map((question) => {
        const answer = instructions.find(
          (item) =>
            item.dialogue?._tag === "answer" &&
            item.dialogue.questionId === question.id
        );
        return answer === undefined ? (
          <QuestionAnswer
            key={question.id}
            question={question}
            sessionId={session.id}
            closed={session.captureState._tag !== "recording"}
          />
        ) : (
          <AnsweredQuestion
            key={question.id}
            question={question}
            answer={answer}
            sessionId={session.id}
          />
        );
      })}
    </section>
  );
};
