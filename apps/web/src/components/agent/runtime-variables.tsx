import type { AgentSessionSnapshot } from "@contingency/protocol";

import {
  DryRunPrerequisiteVariables,
  ExampleVariables,
  WorkspaceVariables,
} from "./dry-run-prerequisite-variables";
import { takesExampleVariables } from "./run-provenance";

/** Private Run inputs supplied directly in Workspace. */
export const RuntimeVariables = ({
  collapse,
  session,
}: {
  /** The tier's collapse control, when this is its first request. */
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => {
  if (session.dryRun?.flowSkillName !== undefined) {
    return (
      <DryRunPrerequisiteVariables collapse={collapse} session={session} />
    );
  }
  if (takesExampleVariables(session)) {
    return <ExampleVariables collapse={collapse} session={session} />;
  }
  return (
    <WorkspaceVariables
      collapse={collapse}
      description="Supply or refuse private inputs here. The agent sees their status, never their values."
      heading="Runtime Variables"
      session={session}
    />
  );
};
