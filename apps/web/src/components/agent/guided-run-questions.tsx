import { OperationId } from "@contingency/protocol";
import type {
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserPredicate,
  TeachingInstruction,
  GuidedRunCheckDecision,
  GuidedRunCheckProposal,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import {
  CornerDownRightIcon,
  MessageCircleQuestionMarkIcon,
} from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { failureMessage } from "@/lib/failure-message";
import { retainedFamily } from "@/lib/retained-state";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import {
  PendingLabel,
  RequestHeader,
  RequestMessage,
  requestIconClassName,
} from "./dock-request-parts";

interface AnswerDraft {
  readonly error: string;
  /** Send was pressed with nothing written. */
  readonly invalid: boolean;
  readonly operationId: OperationId | null;
  readonly pending: boolean;
  readonly text: string;
}

const emptyAnswer: AnswerDraft = {
  error: "",
  invalid: false,
  operationId: null,
  pending: false,
  text: "",
};
const questionAnswerState = retainedFamily(emptyAnswer);
const answerKey = (sessionId: AgentSessionId, questionId: string) =>
  JSON.stringify([sessionId, questionId]);

const OPERATOR: Record<BrowserPredicate["operator"], string> = {
  contains: "contains",
  equals: "=",
  exists: "exists",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

const predicateLine = ({ expected, operator, path }: BrowserPredicate) =>
  [
    path.join("."),
    OPERATOR[operator],
    expected === undefined ? "" : JSON.stringify(expected),
  ]
    .filter((part) => part !== "")
    .join(" ");

/** What a proposed check would add, as a short list rather than its JSON. */
const RESPONSE_TIMING = {
  first: "The first response",
  matching: "Wait for a match",
} as const;
const STORAGE_CHANGE = {
  changed: "Changed after the action",
  created: "Created after the action",
  current: "Current state",
} as const;
const STORAGE_KIND = {
  cookie: "Cookie",
  local: "Local storage",
  session: "Session storage",
} as const;

type ProposalLine = readonly [string, string];

/** The request a response check waits for, with its query constraints. */
const requestLine = ({
  method,
  path,
  query,
}: {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}) => {
  const constraints = new URLSearchParams(Object.entries(query)).toString();
  return `${method} ${path}${constraints === "" ? "" : `?${constraints}`}`;
};

/** What a check targets: the request, or the cookie or storage entry. */
const targetLines = (
  check: Extract<GuidedRunCheckProposal, { _tag: "browser" }>["check"]
): readonly ProposalLine[] => {
  if (check.kind === "response") {
    return [
      ["Request", requestLine(check.request)],
      ["Origin", check.request.origin],
      ["Response", RESPONSE_TIMING[check.response]],
    ];
  }
  const lines: ProposalLine[] = [
    [STORAGE_KIND[check.kind], check.name],
    ["Origin", check.origin],
    ["Change", STORAGE_CHANGE[check.change]],
  ];
  if (check.cookiePath !== undefined && check.cookiePath !== null) {
    lines.push(["Path", check.cookiePath]);
  }
  if (check.format !== undefined) {
    lines.push(["Format", check.format]);
  }
  return lines;
};

/**
 * What a proposed check would add, as a short list rather than its JSON. It
 * keeps every part that changes what the check requires: the target, the item
 * the predicates apply to, the predicates, and when and how long it waits.
 */
const proposalLines = (
  proposal: GuidedRunCheckProposal
): readonly ProposalLine[] => {
  if (proposal._tag === "scan") {
    return [
      ["Scan", `${proposal.scan.mode}, ${proposal.scan.phase}`],
      ["Id", proposal.scan.id],
    ];
  }
  const { check } = proposal;
  const { itemPath, predicates } = check.expectation;
  return [
    ...targetLines(check),
    ...(itemPath.length === 0
      ? []
      : [["One item", itemPath.join(".")] as const]),
    ["Expect", predicates.map(predicateLine).join("; ")],
    ["When", check.when],
    ["Timeout", `${check.timeoutMs} ms`],
    ["Observed", check.demonstrated ? "Yes, while teaching" : "Not yet"],
  ];
};

const CheckProposal = ({
  proposal,
}: {
  readonly proposal: GuidedRunCheckProposal | undefined;
}) => {
  if (proposal === undefined) {
    return null;
  }
  return (
    <div className="bg-island-hover grid gap-1.5 rounded-xl px-3 py-2.5 text-[12.5px]">
      <span className="bg-status-running/14 text-status-running justify-self-start rounded-full px-[7px] py-px text-xs font-semibold">
        {proposal._tag === "scan" ? "Scan" : "Browser Check"}
      </span>
      <p className="text-muted-foreground text-pretty">{proposal.reason}</p>
      <dl className="grid gap-[3px]">
        {proposalLines(proposal).map(([term, detail]) => (
          <div
            className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2"
            key={term}
          >
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-mono wrap-anywhere">{detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

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
  const decision =
    answer.dialogue?._tag === "answer" ? answer.dialogue.decision : undefined;
  return (
    <li className="grid gap-0.5 text-[12.5px]">
      <p className="text-muted-foreground text-pretty wrap-anywhere">
        {question.text}
      </p>
      <p className="flex gap-1.5">
        <CornerDownRightIcon
          aria-hidden="true"
          className="text-muted-foreground mt-[3px] size-[13px] shrink-0"
        />
        <span className="min-w-0 text-pretty wrap-anywhere">
          {decision === undefined ? (
            answer.text
          ) : (
            <strong className="font-medium">
              {decision === "confirm" ? "Check confirmed" : "Check rejected"}
            </strong>
          )}
          <span className="text-muted-foreground">
            {" · "}
            {answer.actor === "agent" ? "relayed by the agent" : "you"}
          </span>
        </span>
      </p>
    </li>
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
  const proposal =
    question.dialogue?._tag === "question"
      ? question.dialogue.proposal
      : undefined;
  const submit = async (decision?: GuidedRunCheckDecision) => {
    if (state.pending) {
      return;
    }
    if (
      decision === undefined &&
      (state.text.trim() === "" || state.operationId === null)
    ) {
      setState((current) => ({ ...current, invalid: true }));
      return;
    }
    setState((current) => ({
      ...current,
      error: "",
      invalid: false,
      pending: true,
    }));
    try {
      const payload = {
        operationId: state.operationId ?? OperationId.make(crypto.randomUUID()),
        questionId: question.id,
        sessionId,
        text: state.text,
      };
      await answer({
        payload:
          decision === undefined
            ? payload
            : {
                ...payload,
                decision,
                text: { confirm: "Confirmed", reject: "Rejected" }[decision],
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
  const invalid = state.invalid && state.text.trim() === "";
  const messageId = `${question.id}-message`;
  const controls = () => {
    if (closed) {
      return (
        <p className="text-muted-foreground text-xs">
          {proposal === undefined
            ? "Unanswered when recording stopped."
            : "Unconfirmed when recording stopped."}
        </p>
      );
    }
    if (proposal === undefined) {
      return (
        <div
          className={cn(
            "border-island-border bg-island-hover grid rounded-[13px] border transition-[border-color,box-shadow] focus-within:border-[#ffc400] focus-within:ring-3 focus-within:ring-[oklch(0.85_0.17_85/0.25)]",
            invalid &&
              "border-status-recording ring-status-recording/18 focus-within:border-status-recording focus-within:ring-status-recording/18 ring-3"
          )}
        >
          <Textarea
            aria-describedby={
              invalid || state.error !== "" ? messageId : undefined
            }
            aria-invalid={invalid || undefined}
            aria-label={`Answer: ${question.text}`}
            className="max-h-36 min-h-[52px] resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            disabled={state.pending}
            id={question.id}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                invalid: false,
                operationId: OperationId.make(crypto.randomUUID()),
                text: event.target.value,
              }))
            }
            onKeyDown={async (event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                await submit();
              }
            }}
            placeholder="Answer in your own words"
            rows={2}
            value={state.text}
          />
          <div className="flex items-center justify-between gap-2 py-1 pr-1 pl-3 text-xs">
            <span className="text-muted-foreground">
              The agent reads this answer.
            </span>
            <Button
              disabled={state.pending || state.text.trim() === ""}
              size="island"
              title="Send answer (⌘↵)"
              type="submit"
            >
              <PendingLabel
                idle="Send answer"
                pending={state.pending}
                working="Sending"
              />
              {state.pending ? null : (
                <Kbd
                  aria-hidden="true"
                  className="bg-primary-foreground/18 text-primary-foreground"
                >
                  ⌘↵
                </Kbd>
              )}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end gap-2">
        <Button
          className="bg-island-hover shadow-[inset_0_0_0_1px_var(--island-border)]"
          disabled={state.pending}
          onClick={() => submit("reject")}
          size="island"
          type="button"
          variant="island"
        >
          Reject check
        </Button>
        <Button
          disabled={state.pending}
          onClick={() => submit("confirm")}
          size="island"
          type="button"
        >
          <PendingLabel
            idle="Confirm check"
            pending={state.pending}
            working="Confirm check"
          />
        </Button>
      </div>
    );
  };
  return (
    <form
      className="grid gap-2"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        await submit();
      }}
    >
      <p className="text-[13.5px] font-medium text-pretty wrap-anywhere">
        {question.text}
      </p>
      <CheckProposal proposal={proposal} />
      {controls()}
      <RequestMessage
        error={state.error === "" ? undefined : state.error}
        id={messageId}
        invalid={invalid ? "Write an answer first." : undefined}
      />
    </form>
  );
};

/**
 * The questions a Guided Run's agent asked, in the dock's request tier. An
 * answered question reads as settled: the question muted, the answer under
 * it. A pending one keeps its weight so it stands out.
 */
export const GuidedRunQuestions = ({
  collapse = null,
  session,
}: {
  /** The Requests island's collapse control. */
  readonly collapse?: React.ReactNode;
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
  const answerOf = (question: TeachingInstruction) =>
    instructions.find(
      (item) =>
        item.dialogue?._tag === "answer" &&
        item.dialogue.questionId === question.id
    );
  const open = questions.filter((question) => answerOf(question) === undefined);
  const answered = questions.flatMap((question) => {
    const answer = answerOf(question);
    return answer === undefined ? [] : [{ answer, question }];
  });
  const [lead] = open;
  const eyebrow = () => {
    if (lead === undefined) {
      return "All answered";
    }
    if (lead.dialogue?._tag === "question" && lead.dialogue.proposal) {
      return "Proposed check";
    }
    return open.length > 1 ? `${open.length} questions` : "Question";
  };
  return (
    <section aria-label="Guided Run questions" className="space-y-3">
      <RequestHeader
        action={collapse}
        badge={eyebrow()}
        icon={
          <MessageCircleQuestionMarkIcon
            aria-hidden="true"
            className={requestIconClassName}
          />
        }
        title="Guided Run questions"
      />
      {open.length === 0 ? null : (
        <div className="space-y-3.5">
          {open.map((question) => (
            <QuestionAnswer
              closed={session.captureState._tag !== "recording"}
              key={question.id}
              question={question}
              sessionId={session.id}
            />
          ))}
        </div>
      )}
      {answered.length === 0 ? null : (
        <ul
          aria-label="Answered questions"
          className={cn(
            "grid gap-2",
            open.length > 0 && "border-island-border border-t pt-2.5"
          )}
        >
          {answered.map(({ answer, question }) => (
            <AnsweredQuestion
              answer={answer}
              key={question.id}
              question={question}
              sessionId={session.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
