import type { AgentSessionId } from "@contingency/protocol";
import { useNavigate } from "@tanstack/react-router";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { workspacePlatformSearch } from "@/components/agent/workspace-platform-state";
import type { WorkspacePlatform } from "@/components/agent/workspace-platform-state";

/**
 * The Workspace under either of its routes: the home and native platforms at
 * `/`, and a Web session at `/<session-id>` (#763).
 */
export const WorkspaceRouteView = ({
  platform,
  sessionId,
}: {
  readonly platform: WorkspacePlatform;
  readonly sessionId: string | undefined;
}) => {
  const navigate = useNavigate();
  const toSession = (
    id: AgentSessionId | undefined,
    replace: boolean
  ): void => {
    if (id === undefined) {
      navigate({ replace, search: {}, to: "/" });
      return;
    }
    navigate({ params: { sessionId: id }, replace, to: "/$sessionId" });
  };
  // Home and each platform have their own URL: moving between them pushes
  // history, so back returns to where the person was; a native session id
  // replaces in place.
  const selectPlatform = (
    next: WorkspacePlatform,
    options?: { readonly replace?: boolean; readonly viewTransition?: boolean }
  ) => {
    navigate({
      replace: options?.replace ?? false,
      search: workspacePlatformSearch(next),
      to: "/",
      viewTransition: options?.viewTransition ?? false,
    });
  };
  return (
    <AgentWorkspace
      onRecoverSession={(id) => toSession(id, true)}
      onSelectPlatform={selectPlatform}
      onSelectSession={(id) => toSession(id, false)}
      platform={platform}
      requestedSessionId={sessionId}
    />
  );
};
