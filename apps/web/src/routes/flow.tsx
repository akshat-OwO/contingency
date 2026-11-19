import { AgentRunId } from "@contingency/protocol";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";

import { AppIslands } from "@/components/app-islands";
import { FlowsPage } from "@/components/catalog/flows-page";
import type { FlowsFolder } from "@/components/catalog/flows-page-state";
import {
  folderFromParam,
  folderParam,
} from "@/components/catalog/flows-page-state";

const isAgentRunId = Schema.is(AgentRunId);
const FlowSearch = Schema.Struct({
  flow: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
});

interface FlowSelectors {
  flow?: string | undefined;
  run?: AgentRunId | undefined;
}

/**
 * The Flows page (#755). It owns the viewport as the Workspace does, under
 * the same two top islands: the way home at the top left, and Flows, Docs and
 * the theme at the top right.
 */
const FlowRouteComponent = () => {
  const { flow, run } = useSearch({ from: "/flow" });
  const navigate = useNavigate({ from: "/flow" });
  const onNavigate = (
    next: {
      readonly flow: FlowsFolder;
      readonly run: AgentRunId | undefined;
    },
    options?: { readonly replace?: boolean }
  ) => {
    void navigate({
      replace: options?.replace ?? false,
      search: { flow: folderParam(next.flow), run: next.run },
    });
  };
  return (
    <div className="workspace-canvas fixed inset-0">
      <AppIslands />
      <FlowsPage
        flow={folderFromParam(flow)}
        onNavigate={onNavigate}
        run={run}
      />
    </div>
  );
};

export const Route = createFileRoute("/flow")({
  component: FlowRouteComponent,
  validateSearch: <Search,>(search: Search): FlowSelectors => {
    const decoded = Schema.decodeUnknownOption(FlowSearch)(search);
    if (Option.isNone(decoded)) {
      return {};
    }
    return {
      flow: decoded.value.flow,
      run: isAgentRunId(decoded.value.run) ? decoded.value.run : undefined,
    };
  },
});
