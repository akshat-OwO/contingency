import type {
  AgentSessionId,
  AgentSessionSnapshot,
  TaskAgentRunState,
} from "@contingency/protocol";
import {
  CircleAlertIcon,
  ListChecksIcon,
  ScrollTextIcon,
  TimerIcon,
} from "lucide-react";
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
import {
  runProvenance,
  sessionTaskRun,
} from "@/components/agent/run-provenance";
import type { RunProvenance } from "@/components/agent/run-provenance";
import { TaskRunDetails } from "@/components/agent/task-run-details";
import {
  DockSessionSelect,
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
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
    <span
      className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs tabular-nums @lg:inline-flex"
      title={notice}
    >
      <TimerIcon aria-hidden="true" className="size-3.5" />
      {notice}
    </span>
  );
};

/**
 * `3 of 6 Agent Steps executed` on a wide stage, `3 of 6` on a narrow one, so
 * the controls row keeps its one line beside the devtools.
 */
const CoverageLabel = ({ coverage }: { readonly coverage: string }) => {
  const short = coverage.replace(/ Agent Steps executed$/u, "");
  if (short === coverage) {
    return coverage;
  }
  return (
    <>
      {short}
      <span className="hidden @2xl:inline"> Agent Steps executed</span>
    </>
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
  const label = <CoverageLabel coverage={coverage} />;
  if (step === undefined) {
    return (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {label}
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
            <ListChecksIcon aria-hidden="true" className="@2xl:hidden" />
            <span className="tabular-nums">{label}</span>
          </Button>
        )}
      />
      <PopoverContent align="end" side="top">
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
 * Marks bundled Example Runs and demo-store work, so a demonstration never
 * reads as a check of the user's own website. An Example is always demo work,
 * so it needs only the one label.
 */
const ProvenanceBadge = ({
  provenance,
}: {
  readonly provenance: RunProvenance | undefined;
}) => {
  if (provenance === undefined) {
    return null;
  }
  if (provenance.example) {
    return (
      <Badge
        title={`Bundled Example Flow Skill on ${provenance.demoSiteName ?? "the demo store"}. It is not your verified work.`}
        variant="outline"
      >
        Example
      </Badge>
    );
  }
  if (provenance.demoSiteName === undefined) {
    return null;
  }
  return (
    <Badge
      title={`Demo work on ${provenance.demoSiteName}, not a real website.`}
      variant="outline"
    >
      Demo store
    </Badge>
  );
};

/** The task behind a Task Run: its original task, instructions, and evidence. */
const TaskDetails = ({
  run,
  title,
}: {
  readonly run: TaskAgentRunState;
  readonly title: string;
}) => (
  <Popover>
    <PopoverTrigger
      render={(props) => (
        <Button {...props} aria-label="Task details" size="sm" variant="ghost">
          <ScrollTextIcon aria-hidden="true" />
          <span className="hidden @xl:inline">Task details</span>
        </Button>
      )}
    />
    <PopoverContent
      align="end"
      side="top"
      className="max-h-[60svh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
    >
      <PopoverTitle>{title}</PopoverTitle>
      <TaskRunDetails run={run} />
    </PopoverContent>
  </Popover>
);

/**
 * The Workspace dock for a Dry Run and an Interactive Run, on the same
 * two-tier card Teaching gets. Above the card's status line sits whatever the
 * agent is waiting on (`requests`); the status line holds the state badge and
 * the next-step sentence; the controls row holds the session picker, how long
 * an idle agent has been quiet, coverage, the task, and the one control that
 * reads `Take control` or `Return control` (#209).
 */
export const RunDock = ({
  controlError,
  controlPending,
  onControl,
  onDismiss,
  onSelectSession,
  requests,
  selectedSessionId,
  session,
  sessions,
  skills = null,
  streamConnected,
}: {
  /** What went wrong the last time this dock tried to change control. */
  readonly controlError: string | undefined;
  readonly controlPending: boolean;
  readonly onControl: () => void;
  /**
   * Leaves an ended Interactive Run and its Run Summary, or `undefined` while
   * there is nothing to leave.
   */
  readonly onDismiss?: (() => void) | undefined;
  readonly onSelectSession: (sessionId: string) => void;
  /** The Execution Boundary and input requests, as the dock's first tier. */
  readonly requests?: React.ReactNode;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly session: RunSessionSnapshot;
  readonly sessions: readonly AgentSessionSnapshot[];
  /** The Skills drawer entry, beside the session picker, or nothing. */
  readonly skills?: React.ReactNode;
  readonly streamConnected: boolean;
}) => {
  const presentation = runDockPresentation(session, streamConnected);
  const control = agentControlPresentation(session);
  const taskRun = sessionTaskRun(session);
  const provenance = taskRun === undefined ? undefined : runProvenance(taskRun);
  return (
    <DockShell
      footer={
        /*
          A refusal takes its own line under the controls rather than a
          floating alert: the status line already says where the user is, and
          the primary action has to stay on screen at 390px.
        */
        controlError === undefined ? null : (
          <p className="text-destructive border-t px-3 py-1.5 text-xs">
            {controlError}
          </p>
        )
      }
      requests={requests}
      status={
        <DockStatus
          badges={
            <>
              <Badge
                variant={
                  presentation.tone === "failed" ? "destructive" : "secondary"
                }
              >
                {presentation.tone === "failed" ? (
                  <CircleAlertIcon aria-hidden="true" />
                ) : null}
                {presentation.badge}
              </Badge>
              <ProvenanceBadge provenance={provenance} />
            </>
          }
        >
          {presentation.nextStep}
        </DockStatus>
      }
    >
      <DockWordmark />
      <DockSessionSelect
        onSelect={onSelectSession}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
      />
      {skills}
      <DockSpacer />
      <AgentIdle session={session} />
      {presentation.coverage === undefined ? null : (
        <RunCoverage
          coverage={presentation.coverage}
          step={presentation.step}
        />
      )}
      {taskRun === undefined ? null : (
        <TaskDetails
          run={taskRun}
          title={session.dryRun ? "Dry Run" : "Interactive Run"}
        />
      )}
      {onDismiss === undefined ? null : (
        <Button onClick={onDismiss} type="button" variant="outline">
          Done
        </Button>
      )}
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
    </DockShell>
  );
};
