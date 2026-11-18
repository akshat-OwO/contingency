import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-dock";
import { useLatestDefined } from "@/hooks/use-latest-defined";

/**
 * The Workspace with an ended Run's Summary on its right. Browser and Android
 * sessions share it, so the summary sits in the same place on both
 * platforms. Flows open on their own page (#755), not beside the Workspace.
 */
export const WorkspaceLayout = ({
  children,
  summary,
  summaryKey,
}: {
  readonly children: React.ReactNode;
  /** The session the summary belongs to; another one opens the dock again. */
  readonly summaryKey?: string | undefined;
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
      summaryKey={summaryKey}
    >
      {children}
    </WorkspaceWithRunSummary>
  );
};
