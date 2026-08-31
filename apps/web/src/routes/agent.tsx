import { createFileRoute, useSearch } from "@tanstack/react-router";

import { AgentWorkspace } from "@/components/agent/agent-workspace";

const AgentRouteComponent = () => {
  const { session } = useSearch({ from: "/agent" });
  return <AgentWorkspace requestedSessionId={session} />;
};

const AgentRoute = createFileRoute("/agent")({
  component: AgentRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === "string" ? search.session : undefined,
  }),
});

export const Route = AgentRoute;
