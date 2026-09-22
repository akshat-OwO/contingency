import type {
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { CircleAlertIcon, TimerIcon } from "lucide-react";

import { agentControlPresentation } from "@/components/agent/agent-workspace-state";
import type {
  RunDockSecondary,
  RunDockStep,
  RunSessionSnapshot,
} from "@/components/agent/run-dock-state";
import { runDockPresentation } from "@/components/agent/run-dock-state";
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

const SECONDARY_LABEL: Record<RunDockSecondary, string> = {
  "extend-run-ceiling": "Extend Run ceiling",
  "extend-step-ceiling": "Extend Agent Step ceiling",
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
 * badge, one next-step sentence, the secondary actions, and at most one
 * primary action — here always the single control that reads `Take control`
 * or `Return control` (#209).
 */
export const RunDock = ({
  controlError,
  controlPending,
  extendError,
  onControl,
  onExtendCeiling,
  onSelectSession,
  selectedSessionId,
  session,
  sessions,
  streamConnected,
}: {
  /** What went wrong the last time this dock tried to change control. */
  readonly controlError: string | undefined;
  readonly controlPending: boolean;
  /** What went wrong the last time this dock tried to raise a ceiling. */
  readonly extendError: string | undefined;
  readonly onControl: () => void;
  readonly onExtendCeiling: (scope: "run" | "step") => void;
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
      {presentation.coverage === undefined ? null : (
        <RunCoverage
          coverage={presentation.coverage}
          step={presentation.step}
        />
      )}
      {presentation.secondaries.map((secondary) => (
        <Button
          key={secondary}
          onClick={() =>
            onExtendCeiling(secondary === "extend-run-ceiling" ? "run" : "step")
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <TimerIcon aria-hidden="true" />
          {SECONDARY_LABEL[secondary]}
        </Button>
      ))}
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
      {controlError === undefined && extendError === undefined ? null : (
        <p className="text-destructive w-full text-xs">
          {controlError ?? extendError}
        </p>
      )}
    </DockShell>
  );
};
