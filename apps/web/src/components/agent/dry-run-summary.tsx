import type {
  AgentTaskAssessment,
  FlowSkillDryRunResult,
} from "@contingency/protocol";
import { agentRunVideoPath } from "@contingency/protocol";
import {
  CircleCheckIcon,
  CircleXIcon,
  CornerDownRightIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  DryRunVerdict,
  TaskDryRunSummary,
} from "@/components/agent/dry-run-summary-state";
import {
  assessmentOutcomeLabel,
  dryRunChecks,
  dryRunVerdict,
  evidenceCount,
  runDuration,
} from "@/components/agent/dry-run-summary-state";
import { RunVideo } from "@/components/agent/run-video";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { ScanResults } from "./scan-results.tsx";

const passedTone = "text-emerald-600 dark:text-emerald-400";

const verdictLabel: Record<DryRunVerdict, string> = {
  "checks-passed": "All checks passed",
  failed: "Dry Run failed",
  passed: "Dry Run passed",
};

const Verdict = ({
  className,
  verdict,
}: {
  readonly className?: string;
  readonly verdict: DryRunVerdict;
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 font-medium",
      verdict === "failed" ? "text-destructive" : passedTone,
      className
    )}
  >
    {verdict === "failed" ? (
      <CircleXIcon aria-hidden="true" className="size-3.5" />
    ) : (
      <CircleCheckIcon aria-hidden="true" className="size-3.5" />
    )}
    {verdictLabel[verdict]}
  </span>
);

/**
 * The recording leads because it is the evidence. The verdict rides on it so
 * the answer and the proof are read together; a Run with no video still says
 * the verdict on its own line. A portrait recording from a mobile emulation is
 * letterboxed to a capped height, so it never pushes the checks off screen.
 * The video and Trace never leave the machine
 * ([ADR 0010](../../../../docs/adr/0010-run-video-is-unredacted.md)).
 */
const DryRunVideo = ({
  src,
  summary,
  verdict,
}: {
  readonly verdict: DryRunVerdict;
  readonly src: string;
  readonly summary: TaskDryRunSummary;
}) => (
  <section aria-label="Run video" className="space-y-1.5">
    {summary.videoPath === null ? (
      <>
        <Verdict className="text-sm" verdict={verdict} />
        <p className="text-muted-foreground text-xs">
          This Run recorded no video.
        </p>
      </>
    ) : (
      <div className="relative">
        <RunVideo
          className="max-h-[min(24rem,50svh)] bg-black object-contain"
          src={src}
        />
        <Verdict
          className="bg-background/90 pointer-events-none absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs shadow-sm"
          verdict={verdict}
        />
      </div>
    )}
    <p className="text-muted-foreground text-xs">
      The video and Trace stay on this machine.
    </p>
  </section>
);

const Stat = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}) => (
  <div className="flex flex-col-reverse px-2 py-2 text-center">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="text-lg font-semibold tabular-nums">{value}</dd>
  </div>
);

const findingDot: Record<AgentTaskAssessment["outcome"], string> = {
  blocked: "bg-amber-500",
  inconclusive: "bg-muted-foreground",
  "not-working": "bg-destructive",
  working: "bg-emerald-500",
};

/** Evidence IDs are what an agent cites back, so they stay readable. */
const EvidenceReferences = ({
  assessment,
}: {
  readonly assessment: AgentTaskAssessment;
}) => (
  <ul aria-label="Browser evidence" className="flex flex-wrap gap-1">
    {assessment.evidence.map((reference) => (
      <li
        className="bg-muted text-muted-foreground max-w-full truncate rounded px-1.5 py-0.5 font-mono text-xs"
        key={`${reference.kind}:${reference.id}`}
        title={`${reference.kind}: ${reference.id}`}
      >
        {reference.kind}: {reference.id}
      </li>
    ))}
  </ul>
);

const Checklist = ({ summary }: { readonly summary: TaskDryRunSummary }) => (
  <ul aria-label="Pass checks" className="divide-y rounded-lg border">
    {dryRunChecks(summary).map((check) => (
      <li
        className="flex items-center gap-2.5 px-3 py-2 text-sm"
        key={check.label}
      >
        {check.passed ? (
          <CircleCheckIcon
            aria-label="Passed"
            className={cn("size-4 shrink-0", passedTone)}
          />
        ) : (
          <CircleXIcon
            aria-label="Failed"
            className="text-destructive size-4 shrink-0"
          />
        )}
        <span className="flex-1">{check.label}</span>
        <span
          className={cn(
            "text-right text-xs",
            check.passed ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {check.value}
        </span>
      </li>
    ))}
  </ul>
);

/**
 * A finished task Dry Run: its video and verdict, four numbers, and the rest
 * behind tabs. The Verdict tab opens on the pass checks, so a failed Dry Run
 * reads as which check is red rather than as paragraphs to compare.
 */
export const DryRunSummaryView = ({
  result,
  summary,
  videoSrc,
}: {
  /** The Runner's observable-outcome result, when the caller has it. */
  readonly result?: FlowSkillDryRunResult;
  readonly summary: TaskDryRunSummary;
  readonly videoSrc?: string | undefined;
}) => {
  const verdict = dryRunVerdict(summary, result);
  return (
    <div className="space-y-3">
      <DryRunVideo
        src={videoSrc ?? agentRunVideoPath(summary.runId)}
        summary={summary}
        verdict={verdict}
      />
      <dl className="grid grid-cols-4 divide-x rounded-lg border">
        <Stat label="Duration" value={runDuration(summary)} />
        <Stat label="Actions" value={summary.timeline.length} />
        <Stat label="Findings" value={summary.findings.length} />
        <Stat label="Evidence" value={evidenceCount(summary)} />
      </dl>
      <ScanResults run={summary} />
      <Tabs defaultValue="verdict">
        <TabsList className="w-full">
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="findings">
            Findings
            {summary.findings.length === 0 ? null : (
              <Badge variant="secondary">{summary.findings.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="task">Task</TabsTrigger>
        </TabsList>
        <TabsContent className="space-y-3 pt-1" value="verdict">
          {result?.outcome === "failed" ? (
            <p className="text-destructive text-sm text-pretty">
              {result.observableOutcome}
            </p>
          ) : null}
          <Checklist summary={summary} />
          {summary.assessment === null ? (
            <p className="text-muted-foreground text-sm">
              No Agent Assessment submitted.
            </p>
          ) : (
            <>
              <blockquote className="border-l-2 pl-3 text-sm text-pretty wrap-anywhere">
                {summary.assessment.explanation}
              </blockquote>
              <EvidenceReferences assessment={summary.assessment} />
            </>
          )}
        </TabsContent>
        <TabsContent className="space-y-3 pt-1" value="findings">
          {summary.findings.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No findings recorded.
            </p>
          ) : (
            <ul aria-label="Findings" className="space-y-3">
              {summary.findings.map((finding) => (
                <li className="flex gap-2.5" key={finding.id}>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      findingDot[finding.outcome]
                    )}
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-pretty wrap-anywhere">
                      {finding.explanation}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {assessmentOutcomeLabel[finding.outcome]}
                    </p>
                    <EvidenceReferences assessment={finding} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent className="space-y-3 pt-1 text-sm" value="task">
          <p className="text-pretty wrap-anywhere">{summary.requestedTask}</p>
          {summary.instructions.length === 0 ? null : (
            <ol aria-label="Changed instructions" className="space-y-1">
              {summary.instructions.map((instruction) => (
                <li
                  className="text-muted-foreground flex gap-1.5 text-xs wrap-anywhere"
                  key={`${instruction.receivedAt}:${instruction.instruction}`}
                >
                  <CornerDownRightIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3 shrink-0"
                  />
                  {instruction.instruction}
                </li>
              ))}
            </ol>
          )}
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt>Flow Skill</dt>
            <dd className="wrap-anywhere">{summary.purpose.flowSkillName}</dd>
            <dt>Run</dt>
            <dd className="font-mono wrap-anywhere">{summary.runId}</dd>
          </dl>
        </TabsContent>
      </Tabs>
    </div>
  );
};
