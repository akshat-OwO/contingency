import type {
  AgentSessionId,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import {
  VariableField,
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { androidDeviceLabel } from "./android-workspace-state";
import { appInstallationQuestion } from "./app-installation";
import { clearDataQuestion } from "./native-starting-data-copy";
import { DockState } from "./workspace-dock";

/** The state label the dock shows. */
export const AndroidStateBadges = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const presentation = androidDockPresentation(session);
  return <DockState tone={presentation.tone}>{presentation.badge}</DockState>;
};

/**
 * What preparation is waiting on, in the dock's request tier: a Run
 * Environment Permission, consent to install or replace an uploaded Target
 * App build, or an action's Confirmation.
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
    <div className="space-y-2 border-b p-3.5">
      {session.preparation.pending.map((decision) => {
        const title = {
          "app-installation": "App installation",
          "clear-app-data": "Clear app data",
          confirmation: "Confirmation",
          "run-environment-permission": "Run Environment Permission",
        }[decision.kind];
        const { environment } = session.selection;
        return (
          <section aria-label={title} key={decision.id}>
            <RequestHeader
              action={
                <>
                  <Button
                    disabled={
                      pending ||
                      (decision.kind === "confirmation" &&
                        session.controller !== "agent")
                    }
                    onClick={() => onDecide(decision.id, true)}
                    size="xs"
                  >
                    Allow
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => onDecide(decision.id, false)}
                    size="xs"
                    variant="outline"
                  >
                    Refuse
                  </Button>
                </>
              }
              icon={
                <ShieldAlertIcon
                  aria-hidden="true"
                  className={requestIconClassName}
                />
              }
              title={title}
            />
            <p className="text-muted-foreground text-xs">
              {decision.kind === "app-installation"
                ? appInstallationQuestion({
                    app: environment.appId,
                    build: environment.appBuild,
                    device: androidDeviceLabel(session.selection.device),
                    installedBuild: decision.installedBuild,
                  })
                : null}
              {decision.kind === "clear-app-data"
                ? clearDataQuestion(
                    environment.appId,
                    androidDeviceLabel(session.selection.device)
                  )
                : null}
              {decision.kind === "confirmation"
                ? `${session.boundary?.description ?? "Android action"}. Allow this exact attempt once; retry needs fresh Confirmation.`
                : null}
              {decision.kind === "run-environment-permission"
                ? `The agent wants to run on ${decision.targetApp}${session.preparation.differences.length === 0 ? "" : ` with ${session.preparation.differences.map((difference) => `${difference.field} ${difference.selected} (taught on ${difference.taught})`).join(", ")}`}.`
                : null}
            </p>
          </section>
        );
      })}
    </div>
  );

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
  readonly session: Pick<AndroidWorkspaceSnapshot, "kind" | "variables">;
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
  let title = session.kind === "dry-run" ? "Dry Run Variables" : "Variables";
  if (variables.some((variable) => variable.setup)) {
    title = "Setup Variables";
  }
  return (
    <section aria-label={title} className="space-y-2 border-b p-3.5">
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
        // The draft stays until the comment saves and the composer closes.
        onSubmit(draft.trim());
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
        // The home's "In progress" heading morphs into this trigger.
        data-vt="switcher"
        className="hover:bg-island-hover dark:hover:bg-island-hover h-[34px] max-w-80 min-w-28 shrink rounded-xl border-transparent bg-transparent pr-2 pl-3 text-sm font-medium dark:bg-transparent"
      >
        <SelectValue placeholder="Android session">
          {(value: string | null) => {
            const label = value === null ? undefined : labels.get(value);
            // No live session is selected, such as while an ended one shows.
            return label === undefined ? (
              <span className="text-muted-foreground truncate">
                Android session
              </span>
            ) : (
              // The whole label, like iOS: the row truncates it if it must.
              <span className="truncate" title={label}>
                {label}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="w-96 max-w-[calc(100vw-2rem)]"
        side="bottom"
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
