import type { AgentSessionSnapshot } from "@contingency/protocol";

import { Button } from "@/components/ui/button";

import { agentControlPresentation } from "./agent-workspace-state";

export const GuidedRunControl = ({
  session,
  onControl,
  pending,
  error,
}: {
  readonly session: AgentSessionSnapshot;
  readonly onControl: () => void;
  readonly pending: boolean;
  readonly error: string | undefined;
}) => {
  if (
    session.activity !== "teaching" ||
    session.origin !== "guided-run" ||
    session.captureState._tag !== "recording"
  ) {
    return null;
  }
  const { action } = agentControlPresentation(session);
  return action === null ? null : (
    <>
      <span role="alert">{error}</span>
      <Button
        disabled={pending}
        onClick={onControl}
        type="button"
        variant="outline"
      >
        {action}
      </Button>
    </>
  );
};
