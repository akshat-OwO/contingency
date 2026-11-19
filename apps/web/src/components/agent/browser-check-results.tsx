import { browserCheckCoverage } from "@contingency/protocol";
import type {
  BrowserCheckResult,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";

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
import { clockTime } from "./run-detail-state";

const STATUS: Record<BrowserCheckResult["status"], string> = {
  failed: "Failed",
  inconclusive: "Inconclusive",
  interrupted: "Interrupted",
  passed: "Passed",
};

const toneOf = (result: BrowserCheckResult | undefined): DetailTone => {
  if (result === undefined) {
    return "open";
  }
  return result.status === "passed" ? "passed" : "failed";
};

/** The Browser Checks the Run's Flows required, and what each watch saw. */
export const BrowserCheckResults = ({
  run,
}: {
  readonly run: TaskAgentRunState | TaskAgentRunSummary;
}) => {
  if ((run.browserChecks?.length ?? 0) === 0) {
    return null;
  }
  const coverage = browserCheckCoverage(run);
  return (
    <DetailSection
      label="Browser Checks"
      meta={`${coverage.fulfilled} of ${coverage.total} required passed`}
      metaTone={coverage.fulfilled === coverage.total ? undefined : "failed"}
    >
      <DetailRows>
        {run.browserChecks?.map(({ check, flowName }) => {
          const result = run.browserCheckResults?.findLast(
            (candidate) =>
              candidate.flowName === flowName && candidate.id === check.id
          );
          const status =
            result === undefined ? "Not evaluated" : STATUS[result.status];
          const tone = toneOf(result);
          return (
            <DetailRow
              key={`${flowName}/${check.id}`}
              lead={<DetailMark label={status} tone={tone} />}
            >
              <DetailRowTitle status={status} tone={tone}>
                <span className="font-mono">{check.id}</span>
              </DetailRowTitle>
              <DetailRowText>
                {result?.summary ??
                  "This required check has not been evaluated."}
              </DetailRowText>
              <DetailRowFoot>
                <span className="wrap-anywhere">{flowName}</span>
                {result === undefined ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono wrap-anywhere">
                      {result.operationId}
                    </span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={result.at} title={result.at}>
                      {clockTime(result.at)}
                    </time>
                  </>
                )}
              </DetailRowFoot>
            </DetailRow>
          );
        })}
      </DetailRows>
    </DetailSection>
  );
};
