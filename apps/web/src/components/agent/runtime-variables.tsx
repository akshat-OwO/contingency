import type { AgentSessionSnapshot } from "@contingency/protocol";

import {
  DryRunPrerequisiteVariables,
  ExampleVariables,
  WorkspaceVariables,
} from "./dry-run-prerequisite-variables";
import { takesExampleVariables } from "./run-provenance";

/** Private Run inputs supplied directly in Workspace. */
export const RuntimeVariables = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  if (session.dryRun?.flowSkillName !== undefined) {
    return <DryRunPrerequisiteVariables session={session} />;
  }
  if (takesExampleVariables(session)) {
    return <ExampleVariables session={session} />;
  }
  return (
    <WorkspaceVariables
      description="Supply or refuse private inputs here. The agent sees their status, never their values."
      heading="Runtime Variables"
      session={session}
    />
  );
};
