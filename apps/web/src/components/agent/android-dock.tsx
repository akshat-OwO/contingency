import type {
  AgentSessionId,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleIcon,
  CornerDownLeftIcon,
  EraserIcon,
  KeyRoundIcon,
  ShieldAlertIcon,
  TextCursorInputIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import {
  VariableField,
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  androidDockPresentation,
  androidSessionLabel,
} from "./android-dock-state";

/**
 * Marks Android as experimental without a banner: one badge beside the state
 * badge, and its title says what to expect.
 */
export const ExperimentalBadge = () => (
  <Badge
    title="Android is experimental. Expect fewer features than the browser Workspace."
    variant="outline"
  >
    Experimental
  </Badge>
);

const BADGE_VARIANT = {
  default: "secondary",
  failed: "destructive",
  recording: "default",
} as const;

/** The state badge the browser dock shows, then the Experimental badge. */
export const AndroidStateBadges = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const presentation = androidDockPresentation(session);
  return (
    <>
      <Badge variant={BADGE_VARIANT[presentation.tone]}>
        {presentation.tone === "recording" ? (
          <CircleIcon
            aria-hidden="true"
            className="fill-current text-red-500"
          />
        ) : null}
        {presentation.tone === "failed" ? (
          <CircleAlertIcon aria-hidden="true" />
        ) : null}
        {presentation.badge}
      </Badge>
      <ExperimentalBadge />
    </>
  );
};

/**
 * What preparation is waiting on, in the dock's request tier: a Run
 * Environment Permission, or consent to clear the Target App's data on a
 * phone before the journey starts.
 */
export const AndroidRequests = ({
  onDecide,
  pending,
  session,
}: {
  readonly onDecide: (decisionId: string, allow: boolean) => void;
  readonly pending: boolean;
  readonly session: AndroidWorkspaceSnapshot;
}) =>
  session.preparation.pending.length === 0 ? null : (
    <div className="bg-muted/50 space-y-2 border-b px-3 py-2.5">
      {session.preparation.pending.map((decision) => {
        const clearing = decision.kind === "clear-app-data";
        const title = clearing
          ? "Clear Target App data"
          : "Run Environment Permission";
        return (
          <section aria-label={title} key={decision.id}>
            <RequestHeader
              action={
                <>
                  <Button
                    disabled={pending}
                    onClick={() => onDecide(decision.id, false)}
                    size="xs"
                    variant="outline"
                  >
                    Refuse
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => onDecide(decision.id, true)}
                    size="xs"
                  >
                    Allow
                  </Button>
                </>
              }
              icon={
                clearing ? (
                  <EraserIcon
                    aria-hidden="true"
                    className={requestIconClassName}
                  />
                ) : (
                  <ShieldAlertIcon
                    aria-hidden="true"
                    className={requestIconClassName}
                  />
                )
              }
              title={title}
            />
            <p className="text-muted-foreground text-xs">
              {clearing
                ? `Contingency clears ${decision.targetApp}'s data for the owner user on ${decision.serial ?? "this device"}, so the journey starts fresh. Nothing else on the device changes.`
                : `The agent wants to run on ${decision.targetApp}${session.preparation.differences.length === 0 ? "" : ` with ${session.preparation.differences.map((difference) => `${difference.field} ${difference.selected} (taught on ${difference.taught})`).join(", ")}`}.`}
            </p>
          </section>
        );
      })}
    </div>
  );

type PickedField = NonNullable<AndroidWorkspaceSnapshot["field"]>;

/** Entry stays in the dock; password fields accept Variable references only. */
export const AndroidFieldEntry = ({
  disabled,
  field,
  onDismiss,
  onSubmit,
  variables,
  onRequest,
  onVariable,
}: {
  readonly disabled: boolean;
  readonly field: PickedField;
  readonly onDismiss: () => void;
  readonly onSubmit: (text: string) => void;
  readonly variables: NonNullable<AndroidWorkspaceSnapshot["variables"]>;
  readonly onRequest: (name: string) => void;
  readonly onVariable: (name: string) => void;
}) => {
  const [draftAtom] = useState(() =>
    Atom.make({ name: "PASSWORD", text: "", variable: "" })
  );
  const [draft, setDraft] = useAtom(draftAtom);
  const label = field.name || field.role;
  const privateField = field.password === true;
  return (
    <form
      aria-label={`Type into ${label}`}
      className="bg-muted/50 space-y-1.5 border-b px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (privateField) {
          if (draft.variable) {
            onVariable(draft.variable);
          }
        } else {
          onSubmit(draft.text);
        }
        setDraft((current) => ({ ...current, text: "" }));
      }}
    >
      <RequestHeader
        title={`Type into ${label}`}
        icon={
          <TextCursorInputIcon
            aria-hidden="true"
            className={requestIconClassName}
          />
        }
        action={
          <Button
            aria-label="Stop typing"
            onClick={onDismiss}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        }
      />
      {privateField ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <NativeSelect
              aria-label="Variable"
              value={draft.variable}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  variable: event.currentTarget.value,
                }))
              }
            >
              <NativeSelectOption value="">
                Choose a Variable
              </NativeSelectOption>
              {variables.map((variable) => (
                <NativeSelectOption
                  disabled={variable.status !== "supplied"}
                  key={variable.name}
                  value={variable.name}
                >
                  {variable.name} · {variable.status}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              disabled={disabled || !draft.variable}
              size="sm"
              type="submit"
            >
              <KeyRoundIcon />
              Enter Variable
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="Variable name"
              maxLength={128}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.currentTarget.value.toUpperCase(),
                }))
              }
            />
            <Button
              disabled={disabled || !/^[A-Z][A-Z0-9_]*$/u.test(draft.name)}
              onClick={() => onRequest(draft.name)}
              size="sm"
              type="button"
              variant="outline"
            >
              Request Variable
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            aria-label={`Text for ${label}`}
            autoFocus
            className="h-8 flex-1"
            maxLength={4096}
            placeholder="Public text"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onDismiss();
              }
            }}
            value={draft.text}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                text: event.currentTarget.value,
              }))
            }
          />
          <Button disabled={disabled} size="sm" type="submit">
            <CornerDownLeftIcon />
            Type
          </Button>
        </div>
      )}
    </form>
  );
};

const AndroidVariableAnswer = ({
  variable,
  pending,
  onSupply,
}: {
  readonly variable: NonNullable<AndroidWorkspaceSnapshot["variables"]>[number];
  readonly pending: boolean;
  readonly onSupply: (
    name: string,
    requestId: string,
    value: string | null
  ) => void;
}) => {
  const [valueAtom] = useState(() => Atom.make(""));
  const [value, setValue] = useAtom(valueAtom);
  return (
    <VariableField
      error={undefined}
      id={variable.requestId}
      label={variable.name}
      purpose={variable.purpose}
      pending={pending}
      value={value}
      onValueChange={setValue}
      supplyLabel={`Supply ${variable.name}`}
      refuseLabel={`Refuse ${variable.name}`}
      onSubmit={() => {
        onSupply(variable.name, variable.requestId, value);
        setValue("");
      }}
      onRefuse={() => {
        onSupply(variable.name, variable.requestId, null);
        setValue("");
      }}
    />
  );
};

export const AndroidVariables = ({
  session,
  pending,
  onSupply,
}: {
  readonly session: AndroidWorkspaceSnapshot;
  readonly pending: boolean;
  readonly onSupply: (
    name: string,
    requestId: string,
    value: string | null
  ) => void;
}) => {
  const variables = session.variables ?? [];
  if (variables.length === 0) {
    return null;
  }
  let title =
    session.kind === "dry-run" ? "Dry Run secrets" : "Private Variables";
  if (variables.some((variable) => variable.setup)) {
    title = "Setup Variables";
  }
  return (
    <section
      aria-label={title}
      className="bg-muted/50 space-y-2 border-b px-3 py-2.5"
    >
      <RequestHeader
        title={title}
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
      />
      {variables.map((variable) =>
        variable.status === "requested" ? (
          <AndroidVariableAnswer
            key={variable.requestId}
            variable={variable}
            pending={pending}
            onSupply={onSupply}
          />
        ) : (
          <p className="text-muted-foreground text-xs" key={variable.requestId}>
            {variable.name} · {variable.status}
          </p>
        )
      )}
    </section>
  );
};

/** A Teaching instruction while recording, in place of the browser composer. */
export const AndroidInstructionEntry = ({
  onDismiss,
  onSubmit,
  pending,
}: {
  readonly onDismiss: () => void;
  readonly onSubmit: (text: string) => void;
  readonly pending: boolean;
}) => {
  const [draftAtom] = useState(() => Atom.make(""));
  const [draft, setDraft] = useAtom(draftAtom);
  return (
    <form
      aria-label="Instruction"
      className="flex items-center gap-1.5 border-b px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() === "") {
          return;
        }
        onSubmit(draft.trim());
        setDraft("");
      }}
    >
      <Input
        aria-label="Instruction"
        autoFocus
        className="h-8 flex-1"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onDismiss();
          }
        }}
        placeholder="Tell the agent what matters on this screen"
        value={draft}
      />
      <Button disabled={pending || draft.trim() === ""} size="sm" type="submit">
        Add
      </Button>
    </form>
  );
};

/** The dock's session picker, labelled like the browser one. */
export const AndroidSessionSelect = ({
  onSelect,
  selectedSessionId,
  sessions,
}: {
  readonly onSelect: (sessionId: string) => void;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AndroidWorkspaceSummary[];
}) => {
  const labels = new Map<string, string>(
    sessions.map((session) => [session.id, androidSessionLabel(session)])
  );
  return (
    <Select
      onValueChange={(value) => {
        if (value !== null) {
          onSelect(value);
        }
      }}
      value={selectedSessionId ?? null}
    >
      <SelectTrigger
        aria-label="Android Agent Session"
        className="max-w-56 min-w-0"
      >
        <SelectValue placeholder="Android session">
          {(value: string | null) => {
            const label = value === null ? undefined : labels.get(value);
            return label === undefined ? null : (
              <span className="truncate">
                {label.split(" · ").at(0) ?? label}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="w-96 max-w-[calc(100vw-2rem)]"
        side="top"
      >
        <SelectGroup>
          <SelectLabel>Android sessions</SelectLabel>
          {sessions.map((session) => {
            const label = labels.get(session.id) ?? session.id;
            const separator = label.lastIndexOf(" · ");
            return (
              <SelectItem
                aria-label={label}
                className="*:first:min-w-0 *:first:shrink"
                key={session.id}
                label={label}
                value={session.id}
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="truncate">{label.slice(0, separator)}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {label.slice(separator + 3)} · {session.phase}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};
