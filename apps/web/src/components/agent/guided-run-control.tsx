import type { AgentSessionSnapshot } from "@contingency/protocol";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { agentControlPresentation } from "./agent-workspace-state";

/** Whether the session is a Guided recording, where control changes hands. */
const isGuidedRecording = (session: AgentSessionSnapshot) =>
  session.activity === "teaching" &&
  session.origin === "guided-run" &&
  session.captureState._tag === "recording";

/**
 * The one control button of a Guided recording (ADR 0065), beside Stop
 * recording. Take over takes the needs-you tone: the agent has stopped and is
 * waiting for the user. A pending change keeps the button's name.
 */
export const GuidedRunControl = ({
  session,
  onControl,
  pending,
}: {
  readonly session: AgentSessionSnapshot;
  readonly onControl: () => void;
  readonly pending: boolean;
}) => {
  if (!isGuidedRecording(session)) {
    return null;
  }
  const { action } = agentControlPresentation(session);
  if (action === null) {
    return null;
  }
  return (
    <Button
      aria-busy={pending || undefined}
      // The dock clears every non-primary button's background, so the
      // needs-you tint is marked important to survive it.
      className={cn(
        action === "Take over" &&
          "border-transparent! bg-[color-mix(in_oklch,var(--island-brand)_22%,transparent)]! text-(--status-needs-you)! shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--island-brand)_45%,transparent)] hover:bg-[color-mix(in_oklch,var(--island-brand)_32%,transparent)]!"
      )}
      disabled={pending}
      onClick={onControl}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin"
        />
      ) : null}
      {action}
    </Button>
  );
};

/**
 * A control change that failed, at the top centre with the other refused
 * gestures (#753). Control did not move, so the button still names the
 * action that failed.
 */
export const GuidedControlNotice = ({
  error,
  session,
}: {
  readonly error: string | undefined;
  readonly session: AgentSessionSnapshot;
}) => {
  if (error === undefined || !isGuidedRecording(session)) {
    return null;
  }
  const { action } = agentControlPresentation(session);
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{action ?? "Control"} did not go through</AlertTitle>
      <AlertDescription>
        {error}{" "}
        {session.controller === "user"
          ? "You still have control."
          : "The agent still has control."}
      </AlertDescription>
    </Alert>
  );
};
