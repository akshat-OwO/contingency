import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  MessageSquareReplyIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type {
  DockBoundary,
  DockInputs,
  DockModel,
  DockVariable,
} from "./fixtures";

/**
 * What the agent is waiting on, as the dock's first tier. A paused Execution
 * Boundary and a request for private inputs used to float as separate cards
 * at the top of the stage, away from the dock's state and its one control.
 * Here they sit directly above the sentence they explain, so the dock reads
 * top to bottom: what is asked, where the run is, what you can do.
 */

/**
 * The state badge below already says `Waiting for confirmation`, so the
 * request names what is being confirmed instead of repeating it.
 */
const REASON_TITLE: Record<DockBoundary["reason"], string> = {
  confirmation: "Confirm this action",
  domain: "Allow a new domain",
  objective: "Confirm an action outside the objective",
};

const REASON_POLICY: Record<DockBoundary["reason"], string> = {
  confirmation:
    "Allowing permits this exact action attempt once. A retry with a new operation id needs another decision.",
  domain:
    "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged.",
  objective:
    "Allowing permits this exact action attempt once. A retry with a new operation id needs another decision.",
};

/** `pending-2ca483b9-…-46aaf28c12e2` reads as `pending-2ca4…12e2`. */
const shortId = (id: string) =>
  id.length <= 20 ? id : `${id.slice(0, 12)}…${id.slice(-4)}`;

/**
 * The pending decision id, copyable. The agent conversation is where the
 * decision is answered (ADR 0037), so the id is the one thing a person may
 * need to carry across; the full id lives in the tooltip and the clipboard.
 */
const DecisionId = ({ id }: { readonly id: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <Button
            {...props}
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
            variant="outline"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {shortId(id)}
          </Button>
        )}
      />
      <TooltipContent className="font-mono">{id}</TooltipContent>
    </Tooltip>
  );
};

const RelayHint = ({
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

const RequestHeader = ({
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

const BoundaryRequest = ({
  boundary,
  collapse,
}: {
  readonly boundary: DockBoundary;
  readonly collapse: React.ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Execution Boundary" className="space-y-1.5">
      <RequestHeader
        action={
          <>
            <Button
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              size="xs"
              variant="ghost"
            >
              {open ? "Hide details" : "Details"}
            </Button>
            {collapse}
          </>
        }
        icon={
          <ShieldAlertIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
        }
        title={REASON_TITLE[boundary.reason]}
      />
      <p className="text-sm text-pretty wrap-anywhere">{boundary.requested}</p>
      {/*
        The description often repeats the request word for word; a second
        identical line reads as a rendering bug, so it only shows when it adds
        something.
      */}
      {boundary.description === boundary.requested ? null : (
        <p className="text-muted-foreground text-xs text-pretty">
          {boundary.description}
        </p>
      )}
      {open ? (
        <div className="bg-background space-y-2 rounded-lg border p-2.5 text-xs">
          <p>
            <span className="text-muted-foreground">Action attempt </span>
            <code className="font-mono wrap-anywhere">
              {boundary.operationId}
            </code>
          </p>
          <pre className="bg-muted/60 max-h-28 overflow-auto rounded-md p-2 font-mono">
            {JSON.stringify(boundary.action, null, 2)}
          </pre>
          <p className="text-muted-foreground text-pretty">
            {REASON_POLICY[boundary.reason]} Take control remains available;
            return control before allowing an agent attempt.
          </p>
        </div>
      ) : null}
      <RelayHint pendingDecisionId={boundary.pendingDecisionId}>
        Reply <strong className="text-foreground font-medium">allow</strong> or{" "}
        <strong className="text-foreground font-medium">refuse</strong> in your
        agent conversation.
      </RelayHint>
    </section>
  );
};

const variableLabel = (variable: DockVariable) =>
  variable.flowSkillName === undefined
    ? variable.name
    : `${variable.flowSkillName}/${variable.name}`;

/**
 * One private input, supplied in place. The field is a password input with
 * a reveal toggle, Supply sits inside the field, and Refuse stays a quiet
 * button beside it so the two answers never look alike.
 */
const VariableField = ({ variable }: { readonly variable: DockVariable }) => {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const id = `variable-${variableLabel(variable)}`;
  return (
    <form
      className="grid gap-x-2 gap-y-1 @lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] @lg:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        setValue("");
      }}
    >
      <label className="min-w-0" htmlFor={id}>
        <span className="block truncate font-mono text-xs">
          {variableLabel(variable)}
        </span>
        {variable.purpose === undefined ? null : (
          <span className="text-muted-foreground block text-xs text-pretty @lg:truncate">
            {variable.purpose}
          </span>
        )}
      </label>
      <div className="flex min-w-0 items-center gap-1.5 @lg:contents">
        <InputGroup className="bg-background h-8 min-w-0 flex-1">
          <InputGroupInput
            autoComplete="off"
            id={id}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Private value"
            type={revealed ? "text" : "password"}
            value={value}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={revealed ? "Hide value" : "Show value"}
              onClick={() => setRevealed((current) => !current)}
              size="icon-xs"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
            <InputGroupButton
              aria-label={`Supply ${variableLabel(variable)}`}
              disabled={value.length === 0}
              type="submit"
              variant="default"
            >
              Supply
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <Button
          aria-label={`Refuse ${variableLabel(variable)}`}
          size="sm"
          type="button"
          variant="ghost"
        >
          Refuse
        </Button>
      </div>
    </form>
  );
};

const AnsweredVariable = ({
  variable,
}: {
  readonly variable: DockVariable;
}) => (
  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
    {variable.status === "supplied" ? (
      <CircleCheckIcon
        aria-hidden="true"
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
      />
    ) : (
      <CircleSlashIcon aria-hidden="true" className="size-3.5" />
    )}
    <span className="font-mono">{variableLabel(variable)}</span>
    {variable.status}
  </p>
);

const InputsRequest = ({
  collapse,
  inputs,
}: {
  readonly collapse: React.ReactNode;
  readonly inputs: DockInputs;
}) => {
  const waiting = inputs.variables.filter(
    (variable) => variable.status === "requested"
  );
  const answered = inputs.variables.filter(
    (variable) => variable.status !== "requested"
  );
  return (
    <section aria-label={inputs.title} className="space-y-2">
      <RequestHeader
        action={
          <>
            {inputs.mode === "form" ? (
              <span className="text-muted-foreground hidden text-xs @xl:inline">
                The agent sees status, never values
              </span>
            ) : null}
            {collapse}
          </>
        }
        badge={
          <Badge variant="secondary">
            {waiting.length} of {inputs.variables.length} needed
          </Badge>
        }
        icon={
          <KeyRoundIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
        }
        title={inputs.title}
      />
      {inputs.mode === "form" ? (
        <div className="space-y-2.5">
          {waiting.map((variable) => (
            <VariableField key={variable.name} variable={variable} />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {waiting.map((variable) => (
            <li className="space-y-1" key={variable.name}>
              <p className="font-mono text-xs">{variableLabel(variable)}</p>
              {variable.purpose === undefined ? null : (
                <p className="text-muted-foreground text-xs">
                  {variable.purpose}
                </p>
              )}
              <RelayHint pendingDecisionId={variable.pendingDecisionId}>
                Supply or refuse this input in your agent conversation.
              </RelayHint>
            </li>
          ))}
        </ul>
      )}
      {answered.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {answered.map((variable) => (
            <AnsweredVariable key={variable.name} variable={variable} />
          ))}
        </div>
      )}
    </section>
  );
};

export const hasRequest = (model: DockModel) =>
  model.boundary !== undefined || model.inputs !== undefined;

/** The dock's request tier, or nothing when the agent is not waiting. */
/** Prototype harness only: `?collapsed` opens every request tier folded. */
const startsCollapsed = new URLSearchParams(globalThis.location.search).has(
  "collapsed"
);

/**
 * Which request the tier was collapsed on. Collapsing is per request: a new
 * Execution Boundary or a new input reopens the tier, because a person who
 * hid the last request has not seen this one.
 */
const requestKey = (model: DockModel) =>
  JSON.stringify([
    model.boundary?.operationId,
    model.inputs?.variables
      .filter((variable) => variable.status === "requested")
      .map((variable) => variable.name),
  ]);

/** The one line a collapsed tier keeps: what is asked, and how to reopen it. */
const CollapsedRequests = ({
  model,
  onExpand,
}: {
  readonly model: DockModel;
  readonly onExpand: () => void;
}) => {
  const { boundary, inputs } = model;
  const waiting =
    inputs?.variables.filter((variable) => variable.status === "requested")
      .length ?? 0;
  const title =
    boundary === undefined
      ? (inputs?.title ?? "")
      : REASON_TITLE[boundary.reason];
  const summary =
    boundary === undefined
      ? `${waiting} of ${inputs?.variables.length ?? 0} needed`
      : boundary.requested;
  return (
    <button
      aria-expanded={false}
      aria-label={`Show request: ${title}. ${summary}`}
      className="hover:bg-muted/70 focus-visible:ring-ring/50 flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
      onClick={onExpand}
      type="button"
    >
      {boundary === undefined ? (
        <KeyRoundIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
      ) : (
        <ShieldAlertIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
      )}
      <span className="shrink-0 text-sm font-medium">{title}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {summary}
      </span>
      {boundary !== undefined && inputs !== undefined ? (
        <Badge variant="secondary">+{waiting} inputs</Badge>
      ) : null}
      <ChevronUpIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
    </button>
  );
};

/**
 * The dock's request tier, or nothing when the agent is not waiting. It
 * collapses to one line so a long request never has to cover the page the
 * person is reading to answer it.
 */
export const DockRequests = ({
  className,
  defaultCollapsed = startsCollapsed,
  model,
}: {
  readonly className?: string;
  /** Starts collapsed; the capture script uses it to show the folded line. */
  readonly defaultCollapsed?: boolean;
  readonly model: DockModel;
}) => {
  const key = requestKey(model);
  const [collapsedKey, setCollapsedKey] = useState<string | undefined>(
    defaultCollapsed ? key : undefined
  );
  if (!hasRequest(model)) {
    return null;
  }
  if (collapsedKey === key) {
    return (
      <div className={cn("bg-muted/50 border-b", className)}>
        <CollapsedRequests
          model={model}
          onExpand={() => setCollapsedKey(undefined)}
        />
      </div>
    );
  }
  const collapse = (
    <Button
      aria-expanded
      aria-label="Collapse request"
      onClick={() => setCollapsedKey(key)}
      size="icon-xs"
      variant="ghost"
    >
      <ChevronDownIcon />
    </Button>
  );
  return (
    <div
      className={cn(
        "bg-muted/50 max-h-[min(45svh,22rem)] space-y-3 overflow-y-auto border-b px-3 py-2.5",
        className
      )}
    >
      {model.boundary === undefined ? null : (
        <BoundaryRequest boundary={model.boundary} collapse={collapse} />
      )}
      {model.inputs === undefined ? null : (
        <InputsRequest
          collapse={model.boundary === undefined ? collapse : null}
          inputs={model.inputs}
        />
      )}
    </div>
  );
};
