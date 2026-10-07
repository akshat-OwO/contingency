import { browserCheckCoverage } from "@contingency/protocol";
import type {
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";

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
    <section aria-label="Browser Checks" className="space-y-2">
      <h3 className="font-semibold">Browser Checks</h3>
      <p>
        {coverage.fulfilled}/{coverage.total} required checks passed
      </p>
      <ul className="space-y-2">
        {run.browserChecks?.map(({ check, flowSkillName }) => {
          const result = run.browserCheckResults?.findLast(
            (candidate) =>
              candidate.flowSkillName === flowSkillName &&
              candidate.id === check.id
          );
          return (
            <li
              className="rounded-lg border p-3"
              key={`${flowSkillName}/${check.id}`}
            >
              <p>
                {flowSkillName} · {check.id}
              </p>
              <p>{result?.status ?? "Unfulfilled"}</p>
              <p>
                {result?.summary ??
                  "This required check has not been evaluated."}
              </p>
              {result === undefined ? null : (
                <p className="text-muted-foreground text-xs">
                  Attempt {result.operationId} · {result.at}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
