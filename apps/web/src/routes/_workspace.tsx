import {
  Navigate,
  createFileRoute,
  useParams,
  useSearch,
} from "@tanstack/react-router";

import { DryRunReview } from "@/components/agent/dry-run-review";
import { workspacePlatformFromSearch } from "@/components/agent/workspace-platform-state";
import { WorkspaceRouteView } from "@/components/agent/workspace-route-view";

/**
 * The Workspace's home (`/`) and a Web session (`/<session-id>`, #763) share
 * this layout, so moving between them keeps the Workspace mounted and the
 * shelf card can grow into the stage.
 */
const WorkspaceLayout = () => {
  const { sessionId } = useParams({ strict: false });
  const { android, ios, recording, run, session } = useSearch({
    strict: false,
  });
  if (recording !== undefined) {
    return <DryRunReview recordingId={recording} />;
  }
  // `open_run` returns `/?run=<id>`. A Run Summary shows only on the Flows
  // page now (#755), so the link lands there with that Run selected.
  if (run !== undefined) {
    return <Navigate replace search={{ run }} to="/flow" />;
  }
  // Every MCP `viewUrl` hands out `/?session=<id>`, which lands on the
  // session's own path without adding a history entry.
  if (sessionId === undefined && session !== undefined) {
    return (
      <Navigate params={{ sessionId: session }} replace to="/$sessionId" />
    );
  }
  return (
    <WorkspaceRouteView
      platform={workspacePlatformFromSearch({ android, ios })}
      sessionId={sessionId}
    />
  );
};

export const Route = createFileRoute("/_workspace")({
  component: WorkspaceLayout,
});
