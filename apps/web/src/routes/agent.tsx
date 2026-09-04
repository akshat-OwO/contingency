import { AgentRunId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Schema } from "effect";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RunViewer } from "@/components/agent/run-view";

const isAgentRunId = Schema.is(AgentRunId);

const AgentRouteComponent = () => {
  const { run, session } = useSearch({ from: "/agent" });
  const navigate = useNavigate({ from: "/agent" });
  // A `run` selector opens persisted evidence, not a live Agent Session. It is
  // what `open_run` returns after the recording process has exited.
  if (run !== undefined) {
    return <RunViewer runId={run} />;
  }
  const selectSession = (sessionId: AgentSessionId) => {
    navigate({ search: { run: undefined, session: sessionId } });
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
    run: isAgentRunId(search.run) ? search.run : undefined,
    session: typeof search.session === "string" ? search.session : undefined,
  }),
});

export const Route = AgentRoute;
