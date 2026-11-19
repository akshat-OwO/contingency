import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  MessageSquareReplyIcon,
} from "lucide-react";
import { useState } from "react";

import { shortDecisionId } from "@/components/agent/dock-requests-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { CopyFeedback, useCopy } from "./evidence-reference";

/**
 * The pieces every request in the Requests island is built from, so an
 * Execution Boundary, setup Variables, prerequisite Variables, and Dry Run
 * secrets read as one surface rather than four cards.
 */

/** The attention icon's color, shared so every request reads the same. */
export const requestIconClassName =
  "size-[17px] shrink-0 text-(--status-needs-you)";

/**
 * A request's header, as the prototype's request card: the icon on a brand
 * tile, the count as an eyebrow over the title, and the collapse control.
 */
export const RequestHeader = ({
  action,
  badge,
  icon,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly badge?: React.ReactNode;
  readonly icon: React.ReactNode;
  readonly title: string;
}) => (
  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
    <span className="grid size-8 place-items-center rounded-[10px] bg-[color-mix(in_oklch,var(--island-brand)_16%,transparent)]">
      {icon}
    </span>
    <div className="grid min-w-0 gap-px">
      {badge === undefined ? null : (
        <span className="text-xs font-semibold tracking-[0.02em] text-(--status-needs-you) [&_*]:text-inherit">
          {badge}
        </span>
      )}
      <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-balance">
        {title}
      </h2>
    </div>
    <div className="flex items-center gap-2">{action}</div>
  </div>
);

/**
 * The one line under a request's title that says who sees what is typed. It
 * lines up with the title, past the icon tile, at every width.
 */
export const RequestNote = ({ children }: { readonly children: string }) => (
  <p className="text-muted-foreground text-[12.5px] text-pretty">{children}</p>
);

/** A failed answer, under the field or question it belongs to. */
export const RequestError = ({
  children,
  id,
}: {
  readonly children: string;
  readonly id?: string;
}) => (
  <p
    className="bg-status-recording/12 text-status-recording rounded-[10px] px-2.5 py-[7px] text-[12.5px] text-pretty"
    id={id}
    role="alert"
  >
    {children}
  </p>
);

/** What an empty answer needs, under the field it marks. */
export const RequestInvalid = ({
  children,
  id,
}: {
  readonly children: string;
  readonly id: string;
}) => (
  <p className="text-status-recording text-xs" id={id}>
    {children}
  </p>
);

/**
 * The line under a field or question: the failure when an answer failed,
 * otherwise what an empty answer needs, otherwise nothing.
 */
export const RequestMessage = ({
  error,
  id,
  invalid,
}: {
  readonly error: string | undefined;
  readonly id: string;
  /** What to say when the answer is empty, or nothing when it is not. */
  readonly invalid: string | undefined;
}) => {
  if (error !== undefined) {
    return <RequestError id={id}>{error}</RequestError>;
  }
  return invalid === undefined ? null : (
    <RequestInvalid id={id}>{invalid}</RequestInvalid>
  );
};

/** Shows or masks a private value while it is typed. */
const RevealValue = ({
  disabled,
  label,
  onToggle,
  shown,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly shown: boolean;
}) => (
  <Button
    aria-label={`${shown ? "Hide" : "Show"} ${label}`}
    aria-pressed={shown}
    className="absolute top-[3px] right-[3px] size-7 rounded-lg"
    disabled={disabled}
    onClick={onToggle}
    size="icon-sm"
    title={shown ? "Hide value" : "Show value"}
    type="button"
    variant="island"
  >
    {shown ? <EyeOffIcon /> : <EyeIcon />}
  </Button>
);

/** The ids that describe a field, or nothing. */
const describedBy = (...ids: readonly (string | false)[]) =>
  ids.filter((part) => part !== false).join(" ") || undefined;

/** A request's primary button while its answer is on the way. */
export const PendingLabel = ({
  idle,
  pending,
  working,
}: {
  readonly idle: string;
  readonly pending: boolean;
  readonly working: string;
}) =>
  pending ? (
    <>
      <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
      {working}
    </>
  ) : (
    idle
  );

/**
 * A pending decision id, copyable. The agent conversation is where the
 * decision is answered (ADR 0037), so the id is the one thing a person may
 * carry across. The button shows its first and last characters; the full id
 * is its accessible name, its title, and what it copies.
 */
export const DecisionId = ({ id }: { readonly id: string }) => {
  const { copied, copy, failed, text } = useCopy(id);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button
        aria-label={`Copy decision id ${id}`}
        className="font-mono"
        onClick={copy}
        size="xs"
        title={id}
        type="button"
        variant="outline"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        {shortDecisionId(id)}
      </Button>
      <CopyFeedback copied={copied} failed={failed} text={text} />
    </span>
  );
};

/** Where an answer is given when it is not given here. */
export const RelayHint = ({
  children,
  pendingDecisionId,
}: {
  readonly children: React.ReactNode;
  readonly pendingDecisionId: string | undefined;
}) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <p className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-xs">
      <MessageSquareReplyIcon
        aria-hidden="true"
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0">{children}</span>
    </p>
    {pendingDecisionId === undefined ? null : (
      <DecisionId id={pendingDecisionId} />
    )}
  </div>
);

/**
 * What a request's purpose adds beyond its label. A default purpose repeats
 * the Variable's name and the evidence notice its group already shows, so
 * only what remains is worth a line.
 */
const purposeBeyondLabel = (
  label: string,
  purpose: string | undefined
): string | undefined => {
  if (purpose === undefined) {
    return undefined;
  }
  const rest = purpose
    .replace(`Supply Variable ${label}.`, "")
    .replace(/The value is visible in session and Run evidence\./u, "")
    .trim();
  return rest === "" ? undefined : rest;
};

/**
 * One Variable answered in place, the same in every Variable request (#776):
 * its name and purpose, then the value with **Supply** and, unless it can
 * only be supplied, **Refuse**. A private value is masked while typed and can
 * be shown. An empty Supply marks the field rather than sending nothing.
 */
export const VariableField = ({
  disabled = false,
  error,
  id,
  label,
  onRefuse,
  onSubmit,
  onValueChange,
  pending,
  private: masked = false,
  purpose,
  refuseLabel,
  supplyLabel,
  value,
}: {
  readonly disabled?: boolean;
  readonly error: string | undefined;
  readonly id: string;
  readonly label: string;
  /** Omitted when the input can only be supplied, like a Dry Run secret. */
  readonly onRefuse?: () => void;
  readonly onSubmit: () => void;
  readonly onValueChange: (value: string) => void;
  readonly pending: boolean;
  /** The agent never sees the value, so it is masked while typed. */
  readonly private?: boolean;
  readonly purpose?: string | undefined;
  readonly refuseLabel?: string;
  readonly supplyLabel: string;
  readonly value: string;
}) => {
  const [viewAtom] = useState(() =>
    Atom.make({ invalid: false, shown: false })
  );
  const [view, setView] = useAtom(viewAtom);
  const detail = purposeBeyondLabel(label, purpose);
  const locked = disabled || pending;
  const messageId = `${id}-message`;
  const invalid = view.invalid && value === "";
  const emptyMessage =
    onRefuse === undefined ? "Enter a value." : "Enter a value, or refuse it.";
  return (
    <form
      className="space-y-1.5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (value === "") {
          setView((current) => ({ ...current, invalid: true }));
          return;
        }
        onSubmit();
      }}
    >
      <div className={cn("grid gap-px", pending && "opacity-60")}>
        <label
          className="font-mono text-[12.5px] font-semibold wrap-anywhere"
          htmlFor={id}
        >
          {label}
        </label>
        {detail === undefined ? null : (
          <p
            className="text-muted-foreground text-xs text-pretty"
            id={`${id}-purpose`}
          >
            {detail}
          </p>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Input
            aria-describedby={describedBy(
              detail !== undefined && `${id}-purpose`,
              (invalid || error !== undefined) && messageId
            )}
            aria-invalid={invalid || undefined}
            autoComplete="off"
            className={cn("h-[34px] font-mono", masked && "pr-9")}
            disabled={locked}
            id={id}
            onChange={(event) => {
              onValueChange(event.target.value);
              setView((current) => ({ ...current, invalid: false }));
            }}
            onKeyDown={(event) => {
              // Supply is off while the field is empty, which blocks the
              // form's own Enter, so an empty Enter is caught here to say why.
              if (event.key === "Enter" && value === "") {
                event.preventDefault();
                setView((current) => ({ ...current, invalid: true }));
              }
            }}
            placeholder="Value"
            spellCheck={false}
            type={masked && !view.shown ? "password" : "text"}
            value={value}
            variant="island"
          />
          {masked ? (
            <RevealValue
              disabled={locked}
              label={label}
              onToggle={() =>
                setView((current) => ({ ...current, shown: !current.shown }))
              }
              shown={view.shown}
            />
          ) : null}
        </div>
        <Button
          aria-label={supplyLabel}
          disabled={locked || value === ""}
          size="island"
          type="submit"
        >
          <PendingLabel idle="Supply" pending={pending} working="Supplying" />
        </Button>
        {onRefuse === undefined ? null : (
          <Button
            aria-label={refuseLabel}
            className="bg-island-hover shadow-[inset_0_0_0_1px_var(--island-border)]"
            disabled={locked}
            onClick={onRefuse}
            size="island"
            type="button"
            variant="island"
          >
            Refuse
          </Button>
        )}
      </div>
      <RequestMessage
        error={error}
        id={messageId}
        invalid={invalid ? emptyMessage : undefined}
      />
    </form>
  );
};

/**
 * The Variables a request no longer waits on, one quiet line each. It says
 * what happened, never the value.
 */
export const AnsweredVariables = ({
  answers,
  label: listLabel = "Answered",
}: {
  /** The list's name: what happened to these Variables. */
  readonly label?: string;
  readonly answers: readonly {
    readonly key: string;
    readonly label: string;
    readonly status: string;
  }[];
}) =>
  answers.length === 0 ? null : (
    <ul
      aria-label={listLabel}
      className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs"
    >
      {answers.map(({ key, label, status }) => (
        <li className="inline-flex items-center gap-1.5" key={key}>
          {status === "refused" ? (
            <CircleSlashIcon
              aria-hidden="true"
              className="text-muted-foreground size-[13px] shrink-0"
            />
          ) : (
            <CircleCheckIcon
              aria-hidden="true"
              className="text-status-ready size-[13px] shrink-0"
            />
          )}
          <span className="font-mono">{label}</span>{" "}
          <span className="text-muted-foreground">{status}</span>
        </li>
      ))}
    </ul>
  );
