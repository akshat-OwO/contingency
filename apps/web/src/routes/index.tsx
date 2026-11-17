import { AgentRunId, TeachingRecordingId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import {
  Navigate,
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { DryRunReview } from "@/components/agent/dry-run-review";
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
  if (recording !== undefined) {
    return <DryRunReview recordingId={recording} />;
  }
  // `open_run` returns `/?run=<id>`. A Run Summary shows only on the Flows
  // page now (#755), so the link lands there with that Run selected.
  if (run !== undefined) {
    return <Navigate replace search={{ run }} to="/flow" />;
  }
  const selectSession = (sessionId: AgentSessionId) => {
    navigate({ search: { run: undefined, session: sessionId } });
  };
  const recoverSession = (sessionId: AgentSessionId | undefined) => {
    navigate({ replace: true, search: { run: undefined, session: sessionId } });
  };
  // Home and each platform have their own URL: moving between them pushes
  // history, so back returns to where the person was; a native session id
  // replaces in place.
  const selectPlatform = (
    platform: WorkspacePlatform,
    options?: { readonly replace?: boolean; readonly viewTransition?: boolean }
  ) => {
    navigate({
      replace: options?.replace ?? false,
      search: workspacePlatformSearch(platform),
      viewTransition: options?.viewTransition ?? false,
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
