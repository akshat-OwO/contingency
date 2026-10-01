import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { CircleAlertIcon, TimerIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { agentControlPresentation } from "@/components/agent/agent-workspace-state";
import type {
  RunDockStep,
  RunSessionSnapshot,
} from "@/components/agent/run-dock-state";
import {
  agentIdleNotice,
  runDockPresentation,
} from "@/components/agent/run-dock-state";
import { TaskRunDetails } from "@/components/agent/task-run-details";
import {
  DockSessionSelect,
  DockShell,
  DockStatus,
  Wordmark,
} from "@/components/agent/workspace-dock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Minutes are the notice's granularity, so a slower tick is never stale. */
const IDLE_TICK_MS = 15_000;

/**
 * How long the agent has gone without calling a tool. It is read-only: a Run
 * has no wall-clock ceiling, so the notice ends nothing and asks nothing of
 * the user. The tick lives in this leaf so it never re-renders the dock or the
 * browser canvas beside it.
 */
const AgentIdle = ({ session }: { readonly session: RunSessionSnapshot }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const interval = globalThis.setInterval(() => {
      setNow(Date.now());
    }, IDLE_TICK_MS);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, []);

  const notice = agentIdleNotice(session, now);
  if (notice === undefined) {
    return null;
  }
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs tabular-nums">
      <TimerIcon aria-hidden="true" className="size-3.5" />
      {notice}
    </span>
  );
};

/**
 * How far the Run got, and behind it the Agent Step it is on. The counter is a
 * control rather than a label whenever there is a step to read: the step's
 * name and its whole `Done when:` clause are the only strings in the dock long
 * enough to break its single row, so they live in a popover and the row keeps
 * the number (#238).
 *
 * With no active Agent Step there is nothing to open, so the counter stays the
 * plain label it was.
 */
const RunCoverage = ({
  coverage,
  step,
}: {
  readonly coverage: string;
  readonly step: RunDockStep | undefined;
}) => {
  if (step === undefined) {
    return (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {coverage}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            aria-label={`${coverage}. ${step.label}.`}
            size="sm"
            variant="ghost"
          >
            <span className="tabular-nums">{coverage}</span>
          </Button>
        )}
      />
      <PopoverContent align="end">
        <PopoverTitle>{step.label}</PopoverTitle>
        <p>{step.name}</p>
        <p className="text-muted-foreground max-h-64 overflow-y-auto text-xs">
          Done when: {step.doneWhen}
        </p>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The Workspace dock for a Dry Run and an Interactive Run. It is the same
 * floating card Teaching gets: the wordmark, the session selector, one state
 * badge, one next-step sentence, how long an idle agent has been quiet, and
 * at most one primary action — here always the single control that reads `Take control`
 * or `Return control` (#209).
 */
export const RunDock = ({
  controlError,
  controlPending,
  onControl,
  onSelectSession,
  selectedSessionId,
  session,
  sessions,
  streamConnected,
}: {
  /** What went wrong the last time this dock tried to change control. */
  readonly controlError: string | undefined;
  readonly controlPending: boolean;
  readonly onControl: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: RunSessionSnapshot;
  readonly sessions: readonly AgentSessionSnapshot[];
  readonly streamConnected: boolean;
}) => {
  const presentation = runDockPresentation(session, streamConnected);
  const control = agentControlPresentation(session);
  return (
    <DockShell>
      <Wordmark />
      <DockSessionSelect
        onSelect={onSelectSession}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
      />
      <Badge
        variant={presentation.tone === "failed" ? "destructive" : "secondary"}
      >
        {presentation.tone === "failed" ? (
          <CircleAlertIcon aria-hidden="true" />
        ) : null}
        {presentation.badge}
      </Badge>
      <DockStatus>
        {presentation.badge}. {presentation.nextStep}
      </DockStatus>
      {session.run !== null && "schemaVersion" in session.run ? (
        <>
          <p
            aria-live="polite"
            className="text-muted-foreground order-last w-full text-xs wrap-anywhere sm:hidden"
          >
            {session.run.instructions.at(-1)?.instruction ??
              session.run.requestedTask}
          </p>
          <Popover>
            <PopoverTrigger
              render={(props) => (
                <Button {...props} size="sm" variant="ghost">
                  Task details
                </Button>
              )}
            />
            <PopoverContent
              align="end"
              side="top"
              className="max-h-[60svh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <PopoverTitle>
                {session.dryRun ? "Dry Run" : "Interactive Run"}
              </PopoverTitle>
              <TaskRunDetails run={session.run} />
            </PopoverContent>
          </Popover>
        </>
      ) : null}
      {presentation.coverage === undefined ? null : (
        <RunCoverage
          coverage={presentation.coverage}
          step={presentation.step}
        />
      )}
      <AgentIdle session={session} />
      {control.action === null ? null : (
        <Button
          disabled={controlPending}
          onClick={onControl}
          type="button"
          variant={session.controller === "user" ? "outline" : "default"}
        >
          {control.action}
        </Button>
      )}
      {/*
        A refusal takes its own line under the controls rather than a floating
        alert: the sentence above it already says where the user is, and the
        primary action has to stay on screen at 390px.
      */}
      {controlError === undefined ? null : (
        <p className="text-destructive w-full text-xs">{controlError}</p>
      )}
    </DockShell>
  );
};
