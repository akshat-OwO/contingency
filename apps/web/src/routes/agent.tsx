import { AgentRunId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RunViewer } from "@/components/agent/run-view";

const isAgentRunId = Schema.is(AgentRunId);
const AgentSearch = Schema.Struct({
  run: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
});

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
  validateSearch: <Search,>(search: Search) => {
    const decoded = Schema.decodeUnknownOption(AgentSearch)(search);
    if (Option.isNone(decoded)) {
      return {};
    }
    return {
      run: isAgentRunId(decoded.value.run) ? decoded.value.run : undefined,
      session: decoded.value.session,
    };
  },
});

export const Route = AgentRoute;
