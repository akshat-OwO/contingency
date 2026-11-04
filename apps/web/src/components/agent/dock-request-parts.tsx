import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  MessageSquareReplyIcon,
} from "lucide-react";
import { useState } from "react";

import { shortDecisionId } from "@/components/agent/dock-requests-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The pieces every request in the dock's first tier is built from, so an
 * Execution Boundary, setup Variables, prerequisite Variables, and Dry Run
 * secrets read as one surface rather than four cards.
 */

/** The attention icon's color, shared so every request reads the same. */
export const requestIconClassName =
  "size-4 shrink-0 text-amber-600 dark:text-amber-400";

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
  <div className="flex min-h-6 items-center gap-2">
    {icon}
    <h2 className="text-sm font-medium">{title}</h2>
    {badge}
    <div className="flex-1" />
    {action}
  </div>
);

/**
 * A pending decision id, copyable. The agent conversation is where the
 * decision is answered (ADR 0037), so the id is the one thing a person may
 * carry across. The button shows its first and last characters; the full id
 * is its accessible name, its title, and what it copies.
 */
export const DecisionId = ({ id }: { readonly id: string }) => {
  const [copiedAtom] = useState(() => Atom.make(false));
  const [copied, setCopied] = useAtom(copiedAtom);
  return (
    <Button
      aria-label={`Copy decision id ${id}`}
      className="font-mono"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
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
 * One input answered in place: the Variable's name and its full purpose over
 * the field, then the value with `Supply` as its own button and `Refuse`
 * outlined beside it, so the two answers never look alike and neither hides
 * inside the field.
 */
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

export const VariableField = ({
  disabled = false,
  error,
  id,
  label,
  onRefuse,
  onSubmit,
  onValueChange,
  pending,
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
  readonly purpose?: string | undefined;
  readonly refuseLabel?: string;
  readonly supplyLabel: string;
  readonly value: string;
}) => {
  const detail = purposeBeyondLabel(label, purpose);
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="min-w-0 space-y-0.5">
        <label
          className="block font-mono text-xs font-medium wrap-anywhere"
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
        <Input
          aria-describedby={detail === undefined ? undefined : `${id}-purpose`}
          autoComplete="off"
          className="bg-background h-8 min-w-0 flex-1"
          disabled={disabled || pending}
          id={id}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Value"
          required
          spellCheck={false}
          type="text"
          value={value}
        />
        <Button
          aria-label={supplyLabel}
          disabled={disabled || pending || value.length === 0}
          size="sm"
          type="submit"
        >
          Supply
        </Button>
        {onRefuse === undefined ? null : (
          <Button
            aria-label={refuseLabel}
            disabled={disabled || pending}
            onClick={onRefuse}
            size="sm"
            type="button"
            variant="outline"
          >
            Refuse
          </Button>
        )}
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

/** An input that is no longer waiting, collapsed to one quiet line. */
export const AnsweredVariable = ({
  label,
  status,
}: {
  readonly label: string;
  readonly status: string;
}) => (
  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
    {status === "supplied" ? (
      <CircleCheckIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    ) : (
      <CircleSlashIcon aria-hidden="true" className="size-3.5 shrink-0" />
    )}
    <span>
      <span className="font-mono">{label}</span> {status}
    </span>
  </p>
);
