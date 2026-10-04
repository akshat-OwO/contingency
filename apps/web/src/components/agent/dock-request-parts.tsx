import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  MessageSquareReplyIcon,
} from "lucide-react";
import { useState } from "react";

import { shortDecisionId } from "@/components/agent/dock-requests-state";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

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
 * One private input answered in place: the Variable's name and purpose, a
 * password field with a reveal toggle and `Supply` inside it, and a quiet
 * `Refuse` beside it so the two answers never look alike. Below about 32rem
 * of stage the label stacks over the field.
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
  const [revealedAtom] = useState(() => Atom.make(false));
  const [revealed, setRevealed] = useAtom(revealedAtom);
  return (
    <form
      className="grid gap-x-2 gap-y-1 @lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] @lg:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="min-w-0">
        <label
          className="block truncate font-mono text-xs"
          htmlFor={id}
          title={label}
        >
          {label}
        </label>
        {purpose === undefined ? null : (
          <p
            className="text-muted-foreground text-xs text-pretty @lg:truncate"
            id={`${id}-purpose`}
            title={purpose}
          >
            {purpose}
          </p>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 @lg:contents">
        <InputGroup className="bg-background h-8 min-w-0 flex-1">
          <InputGroupInput
            aria-describedby={
              purpose === undefined ? undefined : `${id}-purpose`
            }
            autoComplete="off"
            disabled={disabled || pending}
            id={id}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="Private value"
            required
            type={revealed ? "text" : "password"}
            value={value}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={revealed ? "Hide value" : "Show value"}
              aria-pressed={revealed}
              onClick={() => setRevealed((current) => !current)}
              size="icon-xs"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
            <InputGroupButton
              aria-label={supplyLabel}
              disabled={disabled || pending || value.length === 0}
              type="submit"
              variant="default"
            >
              Supply
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {onRefuse === undefined ? null : (
          <Button
            aria-label={refuseLabel}
            disabled={disabled || pending}
            onClick={onRefuse}
            size="sm"
            type="button"
            variant="ghost"
          >
            Refuse
          </Button>
        )}
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-xs @lg:col-span-3" role="alert">
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
