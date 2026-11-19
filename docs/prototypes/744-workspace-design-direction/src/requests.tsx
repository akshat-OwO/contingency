/**
 * Request cards (#776): what the agent waits on the user for, inside the
 * Requests island. Every Variable request (Setup, Runtime, Dry Run,
 * prerequisite and Example inputs) shares one card; Guided Run questions get
 * their own. The Execution Boundary card is #753's and is unchanged.
 */
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  CheckCircleIcon,
  CornerIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  MinusCircleIcon,
  QuestionIcon,
} from "./icons";

/* ------------------------------------------------------------------ model */

/** Which request a Variable belongs to. One card layout serves them all. */
export type VariableGroup =
  | "setup"
  | "runtime"
  | "dry-run"
  | "prerequisite"
  | "example";

export interface VariableItem {
  readonly name: string;
  /** What the value is for, when it says more than the name. */
  readonly purpose?: string;
  /** A Dry Run secret can only be supplied. */
  readonly refusable: boolean;
  /** Set once answered. The value itself is never kept on screen. */
  readonly answer?: "supplied" | "refused";
}

export interface QuestionItem {
  readonly id: string;
  readonly text: string;
  /** The agent proposes a check to add; the user confirms or rejects it. */
  readonly proposal?: {
    readonly kind: "Browser Check" | "Scan";
    readonly reason: string;
    readonly lines: readonly (readonly [string, string])[];
  };
  readonly answer?: {
    readonly text: string;
    readonly by: "user" | "agent";
    readonly decision?: "confirm" | "reject";
  };
}

const GROUP: Record<
  VariableGroup,
  { readonly title: string; readonly note: string; readonly private: boolean }
> = {
  "dry-run": {
    note: "Values are visible in journey evidence.",
    private: true,
    title: "Dry Run Variables",
  },
  example: {
    note: "The demo account takes any password of 8 or more characters. The agent sees whether you answered, never the value.",
    private: true,
    title: "Example private inputs",
  },
  prerequisite: {
    note: "The agent sees whether you answered, never the value.",
    private: true,
    title: "Prerequisite Variables",
  },
  runtime: {
    note: "Values are visible in journey evidence.",
    private: false,
    title: "Runtime Variables",
  },
  setup: {
    note: "Values are visible in journey evidence.",
    private: false,
    title: "Setup Variables",
  },
};

export const variableGroupTitle = (group: VariableGroup) => GROUP[group].title;

/**
 * Forces every field and question into one state, so a reviewer can walk
 * each card through them. "live" lets the card behave: a value of `fail`
 * fails, anything else is accepted after a short wait.
 */
export const REQUEST_STATES = [
  "live",
  "empty",
  "filled",
  "invalid",
  "submitting",
  "error",
  "closed",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const RequestStateContext = createContext<RequestState>("live");

/* ------------------------------------------------------------------ parts */

const Header = ({
  collapse,
  eyebrow,
  icon,
  title,
}: {
  readonly collapse: ReactNode;
  readonly eyebrow: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
}) => (
  <header>
    <span className="request-icon">{icon}</span>
    <div className="request-head">
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
    </div>
    {collapse}
  </header>
);

const Spinner = () => <span aria-hidden="true" className="btn-spinner" />;

/** One line per answered Variable. Never the value, only what happened. */
const Answered = ({ items }: { readonly items: readonly VariableItem[] }) =>
  items.length === 0 ? null : (
    <ul aria-label="Answered" className="var-answered">
      {items.map((item) => (
        <li data-answer={item.answer} key={item.name}>
          {item.answer === "supplied" ? (
            <CheckCircleIcon />
          ) : (
            <MinusCircleIcon />
          )}
          <span className="mono">{item.name}</span>
          <span className="faint">{item.answer}</span>
        </li>
      ))}
    </ul>
  );

/* --------------------------------------------------------------- variable */

type FieldState = Exclude<RequestState, "live" | "closed">;

/** What a field shows when the reviewer forces a state. */
const forcedField = (forced: RequestState, live: FieldState): FieldState =>
  forced === "live" ? live : forced === "closed" ? "empty" : forced;

const VariableField = ({
  item,
  onAnswer,
  private: hidden,
}: {
  readonly item: VariableItem;
  readonly onAnswer: (answer: "supplied" | "refused") => void;
  readonly private: boolean;
}) => {
  const forced = useContext(RequestStateContext);
  const [value, setValue] = useState("");
  const [live, setLive] = useState<FieldState>("empty");
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const state = forcedField(forced, live);
  const shownValue =
    forced === "live"
      ? value
      : state === "filled" || state === "submitting"
        ? "hunter2-staging"
        : "";
  const id = `var-${item.name}`;
  const pending = state === "submitting";
  const message =
    state === "invalid"
      ? item.refusable
        ? "Enter a value, or refuse it."
        : "Enter a value."
      : state === "error"
        ? (error ??
          `Could not supply ${item.name}. The session no longer waits for it.`)
        : null;
  const answer = (kind: "supplied" | "refused") => {
    if (forced !== "live") return;
    if (kind === "supplied" && value === "") {
      setLive("invalid");
      return;
    }
    setLive("submitting");
    setTimeout(() => {
      if (value === "fail") {
        setValue("");
        setError(
          `Could not supply ${item.name}. The session no longer waits for it.`
        );
        setLive("error");
        return;
      }
      setValue("");
      onAnswer(kind);
    }, 700);
  };
  return (
    <form
      className="var-field"
      data-state={state}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        answer("supplied");
      }}
    >
      <label className="var-label" htmlFor={id}>
        <span className="mono">{item.name}</span>
        {item.purpose ? <span className="faint">{item.purpose}</span> : null}
      </label>
      <div className="var-row">
        <span className="var-input">
          <Input
            aria-describedby={message ? `${id}-message` : undefined}
            aria-invalid={state === "invalid" || undefined}
            autoComplete="off"
            className="input mono"
            disabled={pending}
            id={id}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              setLive(e.currentTarget.value === "" ? "empty" : "filled");
            }}
            placeholder="Value"
            spellCheck={false}
            type={hidden && !shown ? "password" : "text"}
            value={shownValue}
          />
          {hidden ? (
            <Button
              aria-label={shown ? `Hide ${item.name}` : `Show ${item.name}`}
              aria-pressed={shown}
              className="var-reveal"
              disabled={pending}
              onClick={() => setShown(!shown)}
              title={shown ? "Hide value" : "Show value"}
            >
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          ) : null}
        </span>
        <Button
          aria-label={`Supply ${item.name}`}
          className="btn compact-btn"
          disabled={pending || shownValue === ""}
          type="submit"
        >
          {pending ? <Spinner /> : null}
          {pending ? "Supplying" : "Supply"}
        </Button>
        {item.refusable ? (
          <Button
            aria-label={`Refuse ${item.name}`}
            className="btn ghosty compact-btn"
            disabled={pending}
            onClick={() => answer("refused")}
          >
            Refuse
          </Button>
        ) : null}
      </div>
      {message ? (
        <p
          className={state === "error" ? "comment-error" : "var-invalid"}
          id={`${id}-message`}
          role={state === "error" ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
};

/**
 * The one Variable card. Every waiting Variable is a field; answered ones
 * fold into a line under them. The eyebrow counts what is still needed.
 */
export const VariableCard = ({
  collapse,
  group,
  items,
  onAnswer,
}: {
  readonly collapse: ReactNode;
  readonly group: VariableGroup;
  readonly items: readonly VariableItem[];
  readonly onAnswer: (name: string, answer: "supplied" | "refused") => void;
}) => {
  const { note, private: hidden, title } = GROUP[group];
  const waiting = items.filter((item) => item.answer === undefined);
  const answered = items.filter((item) => item.answer !== undefined);
  return (
    <section aria-label={title} className="request-card" data-kind="variables">
      <Header
        collapse={collapse}
        eyebrow={`${waiting.length} of ${items.length} needed`}
        icon={<KeyIcon />}
        title={title}
      />
      <p className="request-detail">{note}</p>
      <div className="var-fields">
        {waiting.map((item) => (
          <VariableField
            item={item}
            key={item.name}
            onAnswer={(answer) => onAnswer(item.name, answer)}
            private={hidden}
          />
        ))}
      </div>
      <Answered items={answered} />
    </section>
  );
};

/* --------------------------------------------------------------- question */

const Proposal = ({
  proposal,
}: {
  readonly proposal: NonNullable<QuestionItem["proposal"]>;
}) => (
  <div className="proposal">
    <span className="proposal-kind">{proposal.kind}</span>
    <p>{proposal.reason}</p>
    <dl>
      {proposal.lines.map(([term, detail]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd className="mono">{detail}</dd>
        </div>
      ))}
    </dl>
  </div>
);

const OpenQuestion = ({
  closed,
  onAnswer,
  question,
}: {
  readonly closed: boolean;
  readonly onAnswer: (answer: NonNullable<QuestionItem["answer"]>) => void;
  readonly question: QuestionItem;
}) => {
  const forced = useContext(RequestStateContext);
  const [text, setText] = useState("");
  const [live, setLive] = useState<FieldState>("empty");
  const state = forcedField(forced, live);
  const shownText =
    forced === "live"
      ? text
      : state === "empty" || state === "invalid"
        ? ""
        : "Start them on Starter; Pro needs a card.";
  const pending = state === "submitting";
  useEffect(() => setLive(text.trim() === "" ? "empty" : "filled"), [text]);
  const send = (decision?: "confirm" | "reject") => {
    if (forced !== "live") return;
    if (decision === undefined && text.trim() === "") {
      setLive("invalid");
      return;
    }
    setLive("submitting");
    setTimeout(() => {
      if (text === "fail") {
        setLive("error");
        return;
      }
      onAnswer(
        decision === undefined
          ? { by: "user", text: text.trim() }
          : {
              by: "user",
              decision,
              text: decision === "confirm" ? "Confirmed" : "Rejected",
            }
      );
    }, 700);
  };
  const message =
    state === "invalid"
      ? "Write an answer first."
      : state === "error"
        ? "Could not send the answer. The question stays open; try again."
        : null;
  return (
    <form
      className="question"
      data-state={state}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <p className="question-text">{question.text}</p>
      {question.proposal ? <Proposal proposal={question.proposal} /> : null}
      {closed ? (
        <p className="hint">
          {question.proposal
            ? "Unconfirmed when recording stopped."
            : "Unanswered when recording stopped."}
        </p>
      ) : question.proposal ? (
        <div className="request-row">
          <Button
            className="btn ghosty compact-btn"
            disabled={pending}
            onClick={() => send("reject")}
          >
            Reject check
          </Button>
          <Button
            className="btn compact-btn"
            disabled={pending}
            onClick={() => send("confirm")}
          >
            {pending ? <Spinner /> : null}
            Confirm check
          </Button>
        </div>
      ) : (
        <div
          className="answer-box"
          data-invalid={state === "invalid" || undefined}
        >
          <Textarea
            aria-invalid={state === "invalid" || undefined}
            aria-label={`Answer: ${question.text}`}
            className="answer-field"
            disabled={pending}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Answer in your own words"
            rows={2}
            value={shownText}
          />
          <div className="answer-tools">
            <span className="faint">The agent reads this answer.</span>
            <Button
              className="btn compact-btn"
              disabled={pending || shownText.trim() === ""}
              type="submit"
            >
              {pending ? <Spinner /> : null}
              {pending ? "Sending" : "Send answer"}
              {pending ? null : <kbd className="on-primary">⌘↵</kbd>}
            </Button>
          </div>
        </div>
      )}
      {message ? (
        <p
          className={state === "error" ? "comment-error" : "var-invalid"}
          role={state === "error" ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
};

const AnsweredQuestion = ({
  question,
}: {
  readonly question: QuestionItem;
}) => (
  <li className="answered-question">
    <p className="faint">{question.text}</p>
    <p className="answer-line">
      <CornerIcon />
      <span>
        {question.answer?.decision ? (
          <strong>
            {question.answer.decision === "confirm"
              ? "Check confirmed"
              : "Check rejected"}
          </strong>
        ) : (
          question.answer?.text
        )}
        <span className="faint">
          {" · "}
          {question.answer?.by === "agent" ? "relayed by the agent" : "you"}
        </span>
      </span>
    </p>
  </li>
);

/**
 * A Guided Run's questions (ADR 0065). The open one leads at full weight;
 * answered ones settle under it, quiet, so the thread stays readable.
 */
export const QuestionCard = ({
  closed,
  collapse,
  onAnswer,
  questions,
}: {
  readonly closed: boolean;
  readonly collapse: ReactNode;
  readonly onAnswer: (
    id: string,
    answer: NonNullable<QuestionItem["answer"]>
  ) => void;
  readonly questions: readonly QuestionItem[];
}) => {
  const forced = useContext(RequestStateContext);
  const stopped = closed || forced === "closed";
  const open = questions.filter((q) => q.answer === undefined);
  const answered = questions.filter((q) => q.answer !== undefined);
  const lead = open[0];
  return (
    <section
      aria-label="Guided Run questions"
      className="request-card"
      data-kind="question"
    >
      <Header
        collapse={collapse}
        eyebrow={
          lead === undefined
            ? "All answered"
            : lead.proposal
              ? "Proposed check"
              : open.length > 1
                ? `${open.length} questions`
                : "Question"
        }
        icon={<QuestionIcon />}
        title="Guided Run questions"
      />
      <div className="questions">
        {open.map((question) => (
          <OpenQuestion
            closed={stopped}
            key={question.id}
            onAnswer={(answer) => onAnswer(question.id, answer)}
            question={question}
          />
        ))}
      </div>
      {answered.length === 0 ? null : (
        <ul aria-label="Answered questions" className="answered-questions">
          {answered.map((question) => (
            <AnsweredQuestion key={question.id} question={question} />
          ))}
        </ul>
      )}
    </section>
  );
};
