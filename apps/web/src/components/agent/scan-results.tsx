import { scanCoverage } from "@contingency/protocol";
import type {
  TaskAgentRunState,
  TaskAgentRunSummary,
  ScanMode,
} from "@contingency/protocol";

import { Badge } from "@/components/ui/badge";

const labels: Record<ScanMode, string> = {
  accessibility: "Accessibility",
  navigation: "Upcoming navigation",
  reload: "Page reload",
  timespan: "Interaction timespan",
};

export const ScanResults = ({
  run,
}: {
  readonly run: TaskAgentRunState | TaskAgentRunSummary;
}) => {
  if ((run.scanRequirements?.length ?? 0) === 0) {
    return null;
  }
  const coverage = scanCoverage(run);
  return (
    <section aria-label="Required scans" className="space-y-2">
      <h3 className="font-semibold">Required scans</h3>
      <p
        className={
          coverage.complete ? "text-muted-foreground" : "text-destructive"
        }
      >
        {coverage.fulfilled}/{coverage.total} applicable scans completed
        {coverage.complete ? "" : " · Scan coverage incomplete"}
      </p>
      <ul className="space-y-3">
        {run.scanRequirements?.map((requirement) => {
          const reports = (run.scanReports ?? []).filter(
            (report) =>
              report.flowSkillName === requirement.flowSkillName &&
              report.requirementId === requirement.id
          );
          return (
            <li
              className="space-y-1 rounded-lg border p-3"
              key={`${requirement.flowSkillName}:${requirement.id}`}
            >
              <p className="font-medium">
                {labels[requirement.mode]} · {requirement.when}
              </p>
              {requirement.endWhen === undefined ? null : (
                <p className="text-muted-foreground">
                  Until {requirement.endWhen}
                </p>
              )}
              {requirement.expectedUrl === undefined ? null : (
                <p className="text-muted-foreground break-all">
                  Destination: {requirement.expectedUrl}
                </p>
              )}
              {requirement.outsideScope === undefined ? null : (
                <p>Outside requested scope: {requirement.outsideScope}</p>
              )}
              {reports.length === 0 ? (
                <p className="text-muted-foreground">Not executed</p>
              ) : (
                reports.map((report) => (
                  <div className="space-y-1" key={report.id}>
                    <Badge
                      variant={
                        report.status === "failed" ||
                        report.status === "partial"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {report.status}
                    </Badge>
                    <p>{report.summary}</p>
                    {report.durationMs === undefined ? null : (
                      <p className="text-muted-foreground text-xs">
                        {(report.durationMs / 1000).toFixed(1)}s
                        {report.mode === "timespan"
                          ? " · Agent-driven interval, including reasoning time"
                          : ""}
                      </p>
                    )}
                    {report.reportPath === undefined ? null : (
                      <a
                        className="underline underline-offset-4"
                        href={
                          run.purpose.kind === "dry-run"
                            ? `/teaching-recordings/${encodeURIComponent(run.purpose.recordingId)}/dry-run/scans/${encodeURIComponent(report.id)}`
                            : `/agent-runs/${encodeURIComponent(run.runId)}/scans/${encodeURIComponent(report.id)}`
                        }
                      >
                        Download full report
                      </a>
                    )}
                  </div>
                ))
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
