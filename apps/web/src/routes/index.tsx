import { AgentRunId, TeachingRecordingId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RecordingViewer } from "@/components/agent/recording-view";
import { RunViewer } from "@/components/agent/run-view";
import {
  workspacePlatformFromSearch,
  workspacePlatformSearch,
} from "@/components/agent/workspace-platform-state";
import type { WorkspacePlatform } from "@/components/agent/workspace-platform-state";

const isAgentRunId = Schema.is(AgentRunId);
const WorkspaceSearch = Schema.Struct({
  android: Schema.optional(Schema.String),
  ios: Schema.optional(Schema.String),
  recording: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
});

const WorkspaceRouteComponent = () => {
  const { android, ios, recording, run, session } = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  // A `run` selector opens persisted evidence, not a live Agent Session. It is
  // what `open_run` returns after the recording process has exited.
  if (recording !== undefined) {
    return (
      <main className="mx-auto h-[calc(100svh-3.5rem)] min-h-0 w-full max-w-3xl overflow-y-auto p-6">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">
          Dry Run review
        </h1>
        <RecordingViewer recordingId={recording} />
      </main>
    );
  }
  if (run !== undefined) {
    return <RunViewer runId={run} />;
  }
  const selectSession = (sessionId: AgentSessionId) => {
    navigate({ search: { run: undefined, session: sessionId } });
  };
  const recoverSession = (sessionId: AgentSessionId | undefined) => {
    navigate({ replace: true, search: { run: undefined, session: sessionId } });
  };
  // Each platform has its own URL: switching pushes history, so back returns
  // to the previous platform; a native session id replaces in place.
  const selectPlatform = (
    platform: WorkspacePlatform,
    options?: { readonly replace?: boolean }
  ) => {
    navigate({
      replace: options?.replace ?? false,
      search: workspacePlatformSearch(platform),
    });
  };
  return (
    <AgentWorkspace
      onSelectPlatform={selectPlatform}
      platform={workspacePlatformFromSearch({ android, ios })}
      onRecoverSession={recoverSession}
      onSelectSession={selectSession}
      requestedSessionId={session}
    />
  );
};

interface WorkspaceSelectors {
  android?: string | undefined;
  ios?: string | undefined;
  recording?: TeachingRecordingId;
  run?: AgentRunId | undefined;
  session?: string | undefined;
}

const WorkspaceRoute = createFileRoute("/")({
  component: WorkspaceRouteComponent,
  validateSearch: <Search,>(search: Search): WorkspaceSelectors => {
    const decoded = Schema.decodeUnknownOption(WorkspaceSearch)(search);
    if (Option.isNone(decoded)) {
      return {};
    }
    const selectors: WorkspaceSelectors = {
      run: isAgentRunId(decoded.value.run) ? decoded.value.run : undefined,
      session: decoded.value.session,
    };
    if (decoded.value.android !== undefined) {
      selectors.android = decoded.value.android;
    }
    if (decoded.value.ios !== undefined) {
      selectors.ios = decoded.value.ios;
    }
    if (Schema.is(TeachingRecordingId)(decoded.value.recording)) {
      selectors.recording = decoded.value.recording;
    }
    return selectors;
  },
});

export const Route = WorkspaceRoute;
