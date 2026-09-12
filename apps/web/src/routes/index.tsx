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
const WorkspaceSearch = Schema.Struct({
  run: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
});

const WorkspaceRouteComponent = () => {
  const { run, session } = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
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

const WorkspaceRoute = createFileRoute("/")({
  component: WorkspaceRouteComponent,
  validateSearch: <Search,>(search: Search) => {
    const decoded = Schema.decodeUnknownOption(WorkspaceSearch)(search);
    if (Option.isNone(decoded)) {
      return {};
    }
    return {
      run: isAgentRunId(decoded.value.run) ? decoded.value.run : undefined,
      session: decoded.value.session,
    };
  },
});

export const Route = WorkspaceRoute;
