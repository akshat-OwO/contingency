import { scanCoverage } from "@contingency/protocol";
import type {
  ScanMode,
  ScanReport,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";
import { ExternalLinkIcon } from "lucide-react";

import {
  DetailMark,
  DetailRow,
  DetailRowFoot,
  DetailRowText,
  DetailRowTitle,
  DetailRows,
  DetailSection,
} from "./run-detail-parts";
import type { DetailTone } from "./run-detail-parts";

const labels: Record<ScanMode, string> = {
  accessibility: "Accessibility",
  navigation: "Upcoming navigation",
  reload: "Page reload",
  timespan: "Interaction timespan",
};

const STATUS: Record<ScanReport["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  partial: "Partial",
  running: "Running",
};

const toneOf = (report: ScanReport | undefined): DetailTone => {
  if (report === undefined || report.status === "running") {
    return "open";
  }
  return report.status === "completed" ? "passed" : "failed";
};

const reportHref = (
  run: TaskAgentRunState | TaskAgentRunSummary,
  report: ScanReport
) =>
  run.purpose.kind === "dry-run"
    ? `/teaching-recordings/${encodeURIComponent(run.purpose.recordingId)}/dry-run/scans/${encodeURIComponent(report.id)}`
    : `/agent-runs/${encodeURIComponent(run.runId)}/scans/${encodeURIComponent(report.id)}`;

const Report = ({
  attempt,
  report,
  run,
}: {
  /** Set when the requirement was retried, so each attempt keeps its status. */
  readonly attempt: number | undefined;
  readonly report: ScanReport;
  readonly run: TaskAgentRunState | TaskAgentRunSummary;
}) => (
  <>
    {attempt === undefined ? null : (
      <DetailRowTitle status={STATUS[report.status]} tone={toneOf(report)}>
        <span className="text-muted-foreground text-xs">Attempt {attempt}</span>
      </DetailRowTitle>
    )}
    <p className="mt-1 text-pretty">{report.summary}</p>
    {report.durationMs === undefined &&
    report.reportPath === undefined ? null : (
      <DetailRowFoot>
        {report.durationMs === undefined ? null : (
          <span className="font-mono tabular-nums">
            {(report.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {report.durationMs !== undefined && report.mode === "timespan" ? (
          <span>· Agent-driven interval, including reasoning time</span>
        ) : null}
        {report.reportPath === undefined ? null : (
          <a
            className="text-foreground ml-auto inline-flex items-center gap-1 font-medium underline underline-offset-4"
            href={reportHref(run, report)}
          >
            Download full report
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        )}
      </DetailRowFoot>
    )}
  </>
);

/** ADR 0048: the scans the Run's Flows require, and the reports it took. */
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
    <DetailSection
      label="Required scans"
      meta={`${coverage.fulfilled} of ${coverage.total} completed${coverage.complete ? "" : " · coverage incomplete"}`}
      metaTone={coverage.complete ? undefined : "failed"}
    >
      <DetailRows>
        {run.scanRequirements?.map((requirement) => {
          const reports = (run.scanReports ?? []).filter(
            (report) =>
              report.flowName === requirement.flowName &&
              report.requirementId === requirement.id
          );
          const latest = reports.at(-1);
          const status =
            latest === undefined ? "Not run" : STATUS[latest.status];
          const tone = toneOf(latest);
          return (
            <DetailRow
              key={`${requirement.flowName}:${requirement.id}`}
              lead={<DetailMark label={status} tone={tone} />}
            >
              <DetailRowTitle status={status} tone={tone}>
                {labels[requirement.mode]}
              </DetailRowTitle>
              <DetailRowText>
                When {requirement.when}
                {requirement.endWhen === undefined
                  ? ""
                  : `, until ${requirement.endWhen}`}
              </DetailRowText>
              {requirement.expectedUrl === undefined ? null : (
                <p className="text-muted-foreground/80 font-mono text-xs break-all">
                  {requirement.expectedUrl}
                </p>
              )}
              {requirement.outsideScope === undefined ? null : (
                <p className="text-foreground mt-1 rounded-lg bg-[color-mix(in_oklch,var(--island-brand)_14%,transparent)] px-2 py-1.5 text-[12.5px]">
                  Outside the requested scope: {requirement.outsideScope}
                </p>
              )}
              {reports.map((report, index) => (
                <Report
                  attempt={reports.length > 1 ? index + 1 : undefined}
                  key={report.id}
                  report={report}
                  run={run}
                />
              ))}
            </DetailRow>
          );
        })}
      </DetailRows>
    </DetailSection>
  );
};
