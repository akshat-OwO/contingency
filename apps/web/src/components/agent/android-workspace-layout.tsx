import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-sidebar";
import { useLatestDefined } from "@/hooks/use-latest-defined";

/**
 * The Workspace with an ended Run's Summary on its right. Browser and Android
 * sessions share it, so the summary sits in the same place on both
 * platforms. Flows open on their own page (#755), not beside the Workspace.
 */
export const WorkspaceLayout = ({
  children,
  summary,
}: {
  readonly children: React.ReactNode;
  readonly summary:
    | { readonly label: string; readonly summary: React.ReactNode }
    | null
    | undefined;
}) => {
  const shownLabel = useLatestDefined(summary?.label, "Run Summary");
  return (
    <WorkspaceWithRunSummary
      label={shownLabel}
      summary={summary?.summary ?? null}
    >
      {children}
    </WorkspaceWithRunSummary>
  );
};
