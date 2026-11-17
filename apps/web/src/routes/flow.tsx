import { AgentRunId } from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
import {
  Link,
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { useEffect } from "react";

import { workspaceChromeAtom } from "@/components/agent/agent-workspace-state";
import { islandControlClassName } from "@/components/agent/workspace-home-nav";
import { WatcherMark } from "@/components/brand";
import { FlowsButton } from "@/components/catalog/flows-button";
import { FlowsPage } from "@/components/catalog/flows-page";
import type { FlowsFolder } from "@/components/catalog/flows-page-state";
import {
  folderFromParam,
  folderParam,
} from "@/components/catalog/flows-page-state";
import { DocsLink } from "@/components/docs-link";
import { ModeToggle } from "@/components/mode-toggle";

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
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => {
      setChrome(false);
    };
  }, [setChrome]);
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
      <nav
        aria-label="Workspace"
        className="island absolute top-4 left-4 z-10 flex items-center p-1.5"
      >
        <Link
          aria-label="Contingency home"
          className="hover:bg-island-hover inline-flex items-center gap-2 rounded-[14px] px-2.5 py-1.5"
          search={{ run: undefined, session: undefined }}
          to="/"
          viewTransition
        >
          <WatcherMark className="text-island-brand" data-vt="brand-mark" />
          <span className="text-[15px] font-semibold tracking-[-0.04em] lowercase">
            Contingency
          </span>
        </Link>
      </nav>
      <div className="island absolute top-4 right-4 z-10 flex items-center gap-1 p-1.5">
        <FlowsButton className="text-muted-foreground hover:bg-island-hover hover:text-foreground h-[34px] gap-[7px] rounded-xl px-3 text-sm" />
        <DocsLink className={islandControlClassName} />
        <ModeToggle className={islandControlClassName} />
      </div>
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
