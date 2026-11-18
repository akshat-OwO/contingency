import { AgentRunId, TeachingRecordingId } from "@contingency/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { Option, Schema } from "effect";

const isAgentRunId = Schema.is(AgentRunId);
const WorkspaceSearch = Schema.Struct({
  android: Schema.optional(Schema.String),
  ios: Schema.optional(Schema.String),
  recording: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
});

// The layout in `_workspace.tsx` renders the Workspace; this route only reads
// the home's search.
interface WorkspaceSelectors {
  android?: string | undefined;
  ios?: string | undefined;
  recording?: TeachingRecordingId;
  run?: AgentRunId | undefined;
  session?: string | undefined;
}

const WorkspaceRoute = createFileRoute("/_workspace/")({
  component: () => null,
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
