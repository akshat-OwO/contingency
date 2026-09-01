import type { AgentSessionId } from "@contingency/protocol";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";

import { AgentWorkspace } from "@/components/agent/agent-workspace";

const AgentRouteComponent = () => {
  const { session } = useSearch({ from: "/agent" });
  const navigate = useNavigate({ from: "/agent" });
  const selectSession = (sessionId: AgentSessionId) => {
    navigate({ search: { session: sessionId } });
  };
  return (
    <AgentWorkspace
      onSelectSession={selectSession}
      requestedSessionId={session}
    />
  );
};

const AgentRoute = createFileRoute("/agent")({
  component: AgentRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === "string" ? search.session : undefined,
  }),
});

export const Route = AgentRoute;
