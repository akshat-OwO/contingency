import type {
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  PlusIcon,
  ScrollTextIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  VariableField,
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Button } from "@/components/ui/button";
import {
  DialogCombobox,
  DialogComboboxContent,
  DialogComboboxTitle,
  DialogComboboxTrigger,
} from "@/components/ui/dialog-combobox";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

import {
  androidDockPresentation,
  androidSessionLabel,
  NATIVE_KIND_LABEL,
  nativeSessionTitle,
} from "./android-dock-state";
import { androidDeviceLabel } from "./android-workspace-state";
import { appInstallationQuestion } from "./app-installation";
import { clearDataQuestion } from "./native-starting-data-copy";
import { PlatformIcon } from "./platform-icons";
import {
  DetailEmpty,
  DetailFacts,
  DetailRow,
  DetailRowText,
  DetailRowTitle,
  DetailRows,
  DetailSection,
  FlowPill,
} from "./run-detail-parts";
import { clockTime } from "./run-detail-state";
import { elapsedClock } from "./teaching-recording-state";
import {
  DockState,
  dockSessionPopoverClassName,
  dockSessionTitleClassName,
  dockSessionTriggerClassName,
} from "./workspace-dock";
import type { DockStateTone } from "./workspace-dock";

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
                    variant="primary"
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

/** A session the native picker can name. */
export type NativeSessionChoice = Pick<
  AndroidWorkspaceSummary,
  "flowName" | "id" | "kind"
>;

type NativePlatform = "android" | "ios";

const PLATFORM_NAME: Record<NativePlatform, string> = {
  android: "Android",
  ios: "iOS",
};

/**
 * The native session switcher, on the Web one's contract (#753): a
 * `combobox "Agent Session"` with the platform glyph, opening an `Agent
 * Sessions` dialog. The shown session names itself even after it ends, but
 * only listed sessions are choices. **Close session** lives beside the shown
 * live session here rather than in the Session status island, as Web keeps
 * deletion in its picker.
 */
export const NativeSessionSelect = ({
  close,
  current,
  label,
  onNew,
  onSelect,
  platform,
  sessions,
}: {
  /** Closes the shown live session; absent once it has ended. */
  readonly close?:
    | { readonly onClose: () => void; readonly pending: boolean }
    | undefined;
  /** The shown session, live or ended. */
  readonly current: NativeSessionChoice | undefined;
  /** A row's whole accessible name. */
  readonly label: (session: NativeSessionChoice) => string;
  /** Opens this platform's start card. */
  readonly onNew?: (() => void) | undefined;
  readonly onSelect: (sessionId: string) => void;
  readonly platform: NativePlatform;
  readonly sessions: readonly NativeSessionChoice[];
}) => {
  const [open, setOpen] = useState(false);
  const platformName = PLATFORM_NAME[platform];
  return (
    <DialogCombobox open={open} onOpenChange={setOpen}>
      <DialogComboboxTrigger
        aria-label="Agent Session"
        // The home's "In progress" heading morphs into this trigger.
        data-vt="switcher"
        title={current === undefined ? undefined : label(current)}
        render={
          <Button
            className={dockSessionTriggerClassName}
            size="sm"
            variant="ghost"
          />
        }
      >
        <PlatformIcon className="text-muted-foreground" platform={platform} />
        <span className="truncate font-medium">
          {current === undefined
            ? "Agent Session"
            : nativeSessionTitle(current)}
        </span>
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="text-muted-foreground/70 size-3.5"
        />
      </DialogComboboxTrigger>
      <DialogComboboxContent
        aria-label="Agent Sessions"
        side="bottom"
        sideOffset={14}
        className={dockSessionPopoverClassName}
      >
        <DialogComboboxTitle className={dockSessionTitleClassName}>
          Agent Sessions
        </DialogComboboxTitle>
        <div className="grid max-h-72 gap-0.5 overflow-y-auto">
          {sessions.map((session) => {
            const name = label(session);
            const shown = session.id === current?.id;
            return (
              <div className="flex items-center gap-1" key={session.id}>
                <Button
                  size="md"
                  aria-label={name}
                  aria-pressed={shown}
                  className="hover:bg-island-hover aria-pressed:bg-island-hover grid h-auto min-w-0 flex-1 grid-cols-[32px_minmax(0,1fr)_auto] items-center justify-start gap-3 rounded-[14px] py-[7px] pr-2 pl-[7px] text-left font-normal"
                  onClick={() => {
                    setOpen(false);
                    onSelect(session.id);
                  }}
                  variant="ghost"
                >
                  <span className="bg-island-hover ring-island-border grid size-8 place-items-center rounded-[10px] ring-1 ring-inset">
                    <PlatformIcon className="size-[17px]" platform={platform} />
                  </span>
                  <span className="grid min-w-0">
                    <span className="truncate font-medium">
                      {session.flowName}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {NATIVE_KIND_LABEL[session.kind]} · {platformName}
                    </span>
                  </span>
                  {shown ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                  ) : null}
                </Button>
                {shown && close !== undefined ? (
                  // A word, not a power glyph: it closes the session, not the
                  // device.
                  <Button
                    aria-label="Close session"
                    disabled={close.pending}
                    onClick={() => {
                      setOpen(false);
                      close.onClose();
                    }}
                    size="sm"
                    title={`Close session ${name}`}
                    variant="ghost"
                  >
                    Close
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
        {onNew === undefined ? null : (
          <>
            <hr className="border-island-border mx-1 my-1.5 border-t" />
            <Button
              size="md"
              className="hover:bg-island-hover h-[34px] w-full justify-start gap-[7px] rounded-xl px-3 text-sm font-medium"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
              variant="ghost"
            >
              <PlusIcon aria-hidden="true" />
              New session
            </Button>
          </>
        )}
      </DialogComboboxContent>
    </DialogCombobox>
  );
};

/** The Android session switcher, on the native picker. */
export const AndroidSessionSelect = ({
  close,
  current,
  onNew,
  onSelect,
  sessions,
}: {
  readonly close?:
    | { readonly onClose: () => void; readonly pending: boolean }
    | undefined;
  readonly current?: AndroidWorkspaceSummary | undefined;
  readonly onNew?: (() => void) | undefined;
  readonly onSelect: (sessionId: string) => void;
  readonly sessions: readonly AndroidWorkspaceSummary[];
}) => (
  <NativeSessionSelect
    close={close}
    current={current}
    label={androidSessionLabel}
    onNew={onNew}
    onSelect={onSelect}
    platform="android"
    sessions={sessions}
  />
);

/** How often the Recording chip's clock ticks. */
const TICK_MS = 1000;

/**
 * The elapsed time inside the Recording chip, `mm:ss` in mono, as on the Web
 * (#753). The tick lives in this leaf so it never re-renders the device
 * stage. `role="timer"` is not announced on every tick.
 */
const NativeRecordingElapsed = ({
  startedAt,
}: {
  readonly startedAt: string;
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const interval = globalThis.setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, []);
  const clock = elapsedClock(startedAt, now);
  return (
    <span
      aria-label={`Elapsed recording time ${clock}`}
      className="font-mono text-xs tabular-nums opacity-85"
      role="timer"
    >
      {clock}
    </span>
  );
};

/**
 * A native session's state chip. While recording it carries the recording's
 * elapsed time, `Recording 00:42`, read from when the recording started.
 */
export const NativeStateBadge = ({
  badge,
  recordingStartedAt,
  tone,
}: {
  readonly badge: string;
  readonly recordingStartedAt: string | undefined;
  readonly tone: DockStateTone;
}) => (
  <DockState tone={tone}>
    {badge}
    {tone === "recording" && recordingStartedAt !== undefined ? (
      <NativeRecordingElapsed startedAt={recordingStartedAt} />
    ) : null}
  </DockState>
);

/** The state label the dock shows. */
export const AndroidStateBadges = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const presentation = androidDockPresentation(session);
  return (
    <NativeStateBadge
      badge={presentation.badge}
      recordingStartedAt={
        session.captureState?._tag === "recording"
          ? session.captureState.startedAt
          : undefined
      }
      tone={presentation.tone}
    />
  );
};

/** One fact of a native Run's setup, such as its device. */
export interface NativeTaskFact {
  readonly term: string;
  readonly value: string;
}

/**
 * **Task details** for a native Dry Run or Run, as the Web Run dock's
 * (#778): what it was asked and how it is set up, from the session's own
 * snapshot. A native Run has no task text or Agent Steps, so it shows the
 * Flow, the outcome the Flow ends on, the device setup and its Variables.
 */
export const NativeTaskDetails = ({
  facts,
  session,
}: {
  readonly facts: readonly NativeTaskFact[];
  readonly session: Pick<
    AndroidWorkspaceSnapshot,
    "flowName" | "kind" | "startedAt" | "variables"
  > & {
    readonly selection: Pick<AndroidWorkspaceSnapshot["selection"], "outcomes">;
  };
}) => {
  const trigger = useRef<HTMLButtonElement>(null);
  const { outcomes } = session.selection;
  const variables = session.variables ?? [];
  return (
    <Popover>
      <PopoverTrigger
        ref={trigger}
        render={(props) => (
          <Button
            {...props}
            aria-label="Task details"
            size="sm"
            variant="ghost"
          >
            <ScrollTextIcon aria-hidden="true" />
            <span className="hidden @xl:inline">Task details</span>
          </Button>
        )}
      />
      {/* Above the whole island, so the status line stays readable. */}
      <PopoverContent
        align="end"
        anchor={() => trigger.current?.closest("section") ?? null}
        side="top"
        sideOffset={8}
        className="max-h-[min(60svh,35rem)] w-100 max-w-[calc(100vw-2rem)] overflow-y-auto whitespace-normal"
      >
        <PopoverTitle className="text-muted-foreground/70 text-[11px] font-semibold tracking-[0.04em] uppercase">
          {session.kind === "dry-run" ? "Dry Run" : "Run"}
        </PopoverTitle>
        <div className="grid min-w-0 gap-4">
          <p className="text-[13px] text-pretty">
            {session.kind === "dry-run"
              ? `Repeat the ${session.flowName} Flow from its starting state to show it still reaches its outcome.`
              : `Follow the ${session.flowName} Flow to its outcome.`}
          </p>
          <DetailSection label="Flow">
            <div>
              <FlowPill example={false} name={session.flowName} />
            </div>
          </DetailSection>
          <DetailSection
            label="Intended outcome"
            meta={outcomes.length === 0 ? undefined : String(outcomes.length)}
          >
            {outcomes.length === 0 ? (
              <DetailEmpty>The Flow names no outcome.</DetailEmpty>
            ) : (
              <DetailRows label="Intended outcome">
                {outcomes.map((outcome) => (
                  <DetailRow
                    key={`${outcome.role}:${outcome.name}`}
                    lead={
                      <span
                        aria-hidden="true"
                        className="mx-1 mt-2 size-1.5 shrink-0 rounded-full bg-current opacity-60"
                      />
                    }
                  >
                    <DetailRowTitle>{outcome.name}</DetailRowTitle>
                    <DetailRowText>{outcome.role}</DetailRowText>
                  </DetailRow>
                ))}
              </DetailRows>
            )}
          </DetailSection>
          <DetailSection label="Setup">
            <DetailFacts>
              {facts.map((fact) => (
                <Fragment key={fact.term}>
                  <dt>{fact.term}</dt>
                  <dd>{fact.value}</dd>
                </Fragment>
              ))}
              <dt>Started</dt>
              <dd>
                <time dateTime={session.startedAt} title={session.startedAt}>
                  {clockTime(session.startedAt)}
                </time>
              </dd>
            </DetailFacts>
          </DetailSection>
          {variables.length === 0 ? null : (
            <DetailSection label="Variables" meta={String(variables.length)}>
              <DetailFacts>
                {variables.map((variable) => (
                  <Fragment key={variable.requestId}>
                    <dt className="font-mono">{variable.name}</dt>
                    <dd>{variable.status}</dd>
                  </Fragment>
                ))}
              </DetailFacts>
            </DetailSection>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * How an ended native Run leaves, as the Web ended Run: a filled **Done**,
 * or a quiet one when a Flow decision is the island's action.
 */
export const NativeDoneButton = ({
  onDone,
  quiet,
}: {
  readonly onDone: () => void;
  readonly quiet: boolean;
}) =>
  quiet ? (
    <Button
      size="md"
      className="text-foreground ring-island-border ring-1 ring-inset"
      onClick={onDone}
      type="button"
      variant="ghost"
    >
      Done
    </Button>
  ) : (
    <Button size="md" variant="primary" onClick={onDone} type="button">
      Done
    </Button>
  );
