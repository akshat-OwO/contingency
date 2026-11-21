import type {
  AgentTaskAssessment,
  AgentTaskFinding,
  FlowDryRunResult,
  TaskAgentRunSummary,
} from "@contingency/protocol";
import { agentRunVideoPath } from "@contingency/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  GlobeIcon,
  PlayIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type {
  DryRunVerdict,
  SummaryCheck,
  SummaryVerdict,
  TaskDryRunSummary,
  TaskInteractiveRunSummary,
} from "@/components/agent/dry-run-summary-state";
import {
  assessmentOutcomeLabel,
  dryRunCannotVerify,
  dryRunChecks,
  dryRunChecksPass,
  dryRunFailureSentence,
  dryRunMissedOnlyQualifiers,
  dryRunVerdict,
  evidenceCount,
  interactiveRunChecks,
  interactiveRunVerdict,
  runDuration,
  runOutcomeLabel,
  runSummaryWhen,
} from "@/components/agent/dry-run-summary-state";
import {
  EvidenceList,
  EvidenceReference,
} from "@/components/agent/evidence-reference";
import { usePublishRunSummaryVerdict } from "@/components/agent/run-summary-dock";
import { VerdictCard } from "@/components/agent/run-summary-verdict";
import { RunVideo, RunVideoLocation } from "@/components/agent/run-video";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

import { BrowserCheckResults } from "./browser-check-results";
import { BrowserModifications } from "./browser-modifications";
import { DetailHeadingLevel } from "./run-detail-state";
import { videoClock, videoOffsetMs } from "./run-video-timeline";
import { ScanResults } from "./scan-results.tsx";
import {
  EmulationSection,
  Pursuits,
  ReferencedFlows,
  RequestedTask,
} from "./task-run-details";

const passedTone = "text-status-ready";

/**
 * A persisted record without the Runner's result passes on its checks alone:
 * they are the Runner's pass rule, so it reads as the same "Dry Run passed"
 * the dock shows for that Run.
 */
const verdictLabel: Record<DryRunVerdict, string> = {
  "checks-passed": "Dry Run passed",
  failed: "Dry Run failed",
  passed: "Dry Run passed",
};

const dryRunSummaryVerdict = (verdict: DryRunVerdict): SummaryVerdict => ({
  label: verdictLabel[verdict],
  tone: verdict === "failed" ? "failed" : "passed",
});

/**
 * The verdict card, then what the Run was for, why it cannot pass, and the
 * Agent Assessment's explanation, in that order. The card's tone is the one
 * the collapsed dock's chip carries.
 */
const SummaryVerdictHeader = ({
  explanation,
  facts,
  failure,
  platform,
  title,
  verdict,
}: {
  readonly explanation: string | undefined;
  readonly facts: readonly string[];
  readonly failure: string | undefined;
  readonly platform: ReactNode;
  readonly title: string;
  readonly verdict: SummaryVerdict;
}) => (
  <section aria-label="Run verdict" className="grid gap-3.5">
    <VerdictCard facts={facts} platform={platform} verdict={verdict} />
    <div className="grid gap-1.5">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-pretty wrap-anywhere">
        {title}
      </h3>
      {failure === undefined ? null : (
        <p className="text-foreground/85 text-[13.5px] text-pretty">
          {failure}
        </p>
      )}
      {explanation === undefined ? null : (
        <p className="text-muted-foreground text-[13.5px] text-pretty wrap-anywhere">
          {explanation}
        </p>
      )}
    </div>
  </section>
);

/**
 * The Run's video, directly under the verdict and above the numbers and tabs,
 * so it keeps its place when a tab of a different height opens.
 */
const SummaryVideo = ({
  seekAt,
  src,
  summary,
}: {
  readonly seekAt: VideoSeek | null;
  readonly src: string;
  readonly summary: TaskAgentRunSummary;
}) => (
  <section aria-label="Run video" className="space-y-2">
    {summary.videoPath === null ? (
      <p className="text-muted-foreground text-xs">
        This Run recorded no video.
      </p>
    ) : (
      <RunVideo
        note="The video and Trace stay on this machine."
        // The path is copied from the Task tab, not under the player.
        pathInPlayer={false}
        seekAt={seekAt}
        src={src}
        timeMap={summary.videoTimeMap}
        timeline={summary.timeline}
        videoClassName="max-h-[min(15rem,32svh)] max-md:max-h-[20svh]"
      />
    )}
  </section>
);

const Stat = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}) => (
  <div className="flex flex-col-reverse gap-px px-1.5 py-2 text-center">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="text-base font-semibold tabular-nums">{value}</dd>
  </div>
);

const findingDot: Record<AgentTaskAssessment["outcome"], string> = {
  blocked: "[--dot:var(--status-needs-you)]",
  inconclusive: "[--dot:var(--muted-foreground)]",
  "not-working": "[--dot:var(--destructive)]",
  working: "[--dot:var(--status-ready)]",
};

const FindingDot = ({
  outcome,
}: {
  readonly outcome: AgentTaskAssessment["outcome"];
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "mx-1 mt-1.5 size-2 shrink-0 rounded-full bg-(--dot) shadow-[0_0_0_3px_color-mix(in_oklch,var(--dot)_18%,transparent)]",
      findingDot[outcome]
    )}
  />
);

const CheckMark = ({ check }: { readonly check: SummaryCheck }) => {
  if (check.notApplicable === true) {
    return (
      <CircleMinusIcon
        aria-label="Not required"
        className="text-muted-foreground/70 size-4 shrink-0"
        role="img"
      />
    );
  }
  return check.passed ? (
    <CircleCheckIcon
      aria-label="Passed"
      className={cn("size-4 shrink-0", passedTone)}
      role="img"
    />
  ) : (
    <CircleXIcon
      aria-label="Failed"
      className="text-destructive size-4 shrink-0"
      role="img"
    />
  );
};

const Checklist = ({
  checks,
  label,
}: {
  readonly checks: readonly SummaryCheck[];
  readonly label: string;
}) => (
  <ul
    aria-label={label}
    className="divide-island-border rounded-[14px] shadow-[inset_0_0_0_1px_var(--island-border)] [&>li+li]:border-t"
  >
    {checks.map((check) => (
      <li
        className="border-island-border grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2 text-[13px]"
        key={check.label}
      >
        <CheckMark check={check} />
        <span>{check.label}</span>
        <span
          className={cn(
            "text-right text-[12.5px]",
            check.passed
              ? "text-muted-foreground"
              : "text-destructive font-medium"
          )}
        >
          {check.value}
        </span>
      </li>
    ))}
  </ul>
);

/** A moment of the Run for the video to show, with a key to repeat it. */
interface VideoSeek {
  readonly at: string;
  readonly key: number;
}

/**
 * When a finding was observed: the first action it cites, or when the agent
 * submitted it.
 */
const findingMoment = (
  summary: TaskAgentRunSummary,
  finding: AgentTaskFinding
): string => {
  const attempts = new Set<string>();
  for (const evidence of finding.evidence) {
    if (evidence.kind === "attempt") {
      attempts.add(evidence.id);
    }
  }
  return (
    summary.timeline.find((entry) => attempts.has(entry.id))?.at ??
    finding.submittedAt
  );
};

/**
 * A finding's button to its moment in the video, when the video holds that
 * moment. It names the moment by the video's own clock, the one the player
 * shows, so a condensed video's skipped Idle Gaps do not shift it.
 */
const FindingSeek = ({
  at,
  onSeek,
  summary,
  videoSrc,
}: {
  readonly at: string;
  readonly onSeek: (at: string) => void;
  readonly summary: TaskAgentRunSummary;
  readonly videoSrc: string;
}) => {
  const { runVideoStatusAtom } = useRpcDependencies();
  const status = useAtomValue(runVideoStatusAtom(videoSrc));
  const timeMap = summary.videoTimeMap;
  if (
    summary.videoPath === null ||
    timeMap === undefined ||
    status._tag !== "Success" ||
    status.value.state !== "ready"
  ) {
    return null;
  }
  const videoMs = videoOffsetMs(
    timeMap,
    status.value.condensed,
    Date.parse(at) - Date.parse(timeMap.startedAt)
  );
  if (videoMs === undefined || !Number.isFinite(videoMs) || videoMs < 0) {
    return null;
  }
  // The player's own clock, which shows tenths on a short video.
  const last = timeMap.segments.at(-1);
  let durationMs: number | undefined;
  if (last !== undefined) {
    durationMs = status.value.condensed ? last.videoToMs : last.runToMs;
  }
  const clock = videoClock(videoMs, durationMs);
  return (
    <Button
      aria-label={`Show ${clock} in the Run video`}
      className="bg-island-hover ring-island-border hover:text-status-running hover:ring-status-running h-[22px] gap-1 rounded-[7px] px-1.5 font-mono text-xs ring-1 ring-inset"
      onClick={() => {
        onSeek(at);
      }}
      size="xs"
      type="button"
      variant="ghost"
    >
      <PlayIcon aria-hidden="true" className="size-2.5" />
      {clock}
    </Button>
  );
};

/** One of the four numbers under the Run video. */
export interface RunSummaryStat {
  readonly label: string;
  readonly value: ReactNode;
}

/** The Run ID, ready to copy, then ways out of the summary. */
export const RunSummaryFooter = ({
  id,
  kind,
  links,
}: {
  readonly id: string;
  /** What the ID names, such as `Run ID`. */
  readonly kind: string;
  readonly links?: ReactNode;
}) => (
  <footer className="border-island-border flex flex-wrap items-center gap-2 border-t pt-3">
    <EvidenceReference id={id} kind={kind} />
    {links === undefined || links === null ? null : (
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{links}</div>
    )}
  </footer>
);

/**
 * Every Run Summary's frame, Web or native (#757): its verdict, its video,
 * four numbers, and the rest behind three segments. The video sits above the
 * segments so switching never moves it. The checks open first, so a failed
 * Run reads as which check is red rather than as paragraphs to compare.
 * Callers fill the video, the numbers, and each segment's body.
 */
export const RunSummaryFrame = ({
  checks,
  checksDetail,
  checksLabel,
  checksTab,
  explanation,
  facts,
  failure,
  findings,
  findingsCount,
  footer,
  notice,
  platform,
  stats,
  task,
  title,
  verdict,
  video,
}: {
  readonly checks: readonly SummaryCheck[];
  /** What the checks segment shows under the checklist, such as evidence. */
  readonly checksDetail: ReactNode;
  /** Names the checklist. */
  readonly checksLabel: string;
  /** Names the checks segment. */
  readonly checksTab: string;
  /** The Agent Assessment's explanation, under the title. */
  readonly explanation: string | undefined;
  /** The verdict card's facts, such as the kind and when it ended. */
  readonly facts: readonly string[];
  /** A sentence that outranks the checks, such as a failed observable outcome. */
  readonly failure: string | undefined;
  /** The findings segment's body. */
  readonly findings: ReactNode;
  readonly findingsCount: number;
  /** Closes the summary, such as `RunSummaryFooter`. */
  readonly footer: ReactNode;
  /** Something that leads the summary, such as the error a session ended on. */
  readonly notice?: ReactNode;
  /** The platform on the verdict card, with its glyph. */
  readonly platform: ReactNode;
  readonly stats: readonly RunSummaryStat[];
  /** The Task segment's body. */
  readonly task: ReactNode;
  readonly title: string;
  readonly verdict: SummaryVerdict;
  /** The Run video's region. */
  readonly video: ReactNode;
}) => {
  usePublishRunSummaryVerdict(verdict);
  const failing = checks.some(
    (check) => !check.passed && check.notApplicable !== true
  );
  return (
    <div className="grid gap-3.5" data-slot="run-summary">
      {notice}
      <SummaryVerdictHeader
        explanation={explanation}
        facts={facts}
        failure={failure}
        platform={platform}
        title={title}
        verdict={verdict}
      />
      {video}
      <dl className="grid grid-cols-4 rounded-[14px] shadow-[inset_0_0_0_1px_var(--island-border)] [&>div+div]:border-l [&>div+div]:border-(--island-border)">
        {stats.map((stat) => (
          <Stat key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </dl>
      {/* Its sections sit one level under the summary's level 3 title. */}
      <DetailHeadingLevel value={4}>
        <Tabs className="gap-3" defaultValue="checks">
          <TabsList aria-label="Run Summary sections">
            <TabsTrigger value="checks">
              {checksTab}
              {failing ? (
                // The checklist names the failed check; the dot only draws
                // the eye, so the segment keeps one stable name.
                <span
                  aria-hidden="true"
                  className="bg-destructive size-1.5 rounded-full"
                />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="findings">
              Findings{" "}
              <span className="text-muted-foreground/80 font-mono text-xs tabular-nums">
                {findingsCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="task">Task</TabsTrigger>
          </TabsList>
          <TabsContent className="grid gap-4" value="checks">
            <Checklist checks={checks} label={checksLabel} />
            {checksDetail}
          </TabsContent>
          <TabsContent className="grid gap-4" value="findings">
            {findings}
          </TabsContent>
          <TabsContent className="grid gap-4 text-sm" value="task">
            {task}
          </TabsContent>
        </Tabs>
      </DetailHeadingLevel>
      {footer}
    </div>
  );
};

/** The Task segment's closing facts, such as how the Run executed. */
export const RunSummaryTaskFacts = ({
  children,
}: {
  readonly children: ReactNode;
}) => (
  <dl className="border-island-border [&_dt]:text-muted-foreground grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-t pt-3 text-[12.5px]">
    {children}
  </dl>
);

/**
 * A finished task Run in the shared frame. Each finding can show its moment
 * in the video. The Run ID closes the summary, ready to copy.
 */
const TaskRunSummaryLayout = ({
  checks,
  checksLabel,
  checksTab,
  details,
  failure,
  kind,
  links,
  summary,
  taskLabel,
  title,
  verdict,
  videoSrc,
}: {
  readonly checks: readonly SummaryCheck[];
  /** Names the checklist. */
  readonly checksLabel: string;
  /** Names the checks segment. */
  readonly checksTab: string;
  /** What the Task tab adds about where the task came from. */
  readonly details: ReactNode;
  /** A sentence that outranks the checks, such as a failed observable outcome. */
  readonly failure: string | undefined;
  /** `Dry Run` or `Interactive Run`, on the verdict card. */
  readonly kind: string;
  /** Ways out of the summary, such as its Dry Run review, by the Run ID. */
  readonly links: ReactNode;
  readonly summary: TaskAgentRunSummary;
  /** Heads the requested task in the Task tab. */
  readonly taskLabel: string;
  readonly title: string;
  readonly verdict: SummaryVerdict;
  readonly videoSrc: string | undefined;
}) => {
  const [seekAtom] = useState(() => Atom.make<VideoSeek | null>(null));
  const [seekAt, setSeekAt] = useAtom(seekAtom);
  const onSeek = (at: string) => {
    setSeekAt({ at, key: (seekAt?.key ?? 0) + 1 });
  };
  const src = videoSrc ?? agentRunVideoPath(summary.runId);
  const when = runSummaryWhen(summary.endedAt);
  return (
    <RunSummaryFrame
      checks={checks}
      checksDetail={
        <>
          {summary.assessment === null ? (
            <p className="text-muted-foreground text-sm">
              No Agent Assessment submitted.
            </p>
          ) : (
            <EvidenceList hint evidence={summary.assessment.evidence} />
          )}
          <BrowserCheckResults run={summary} />
          <ScanResults run={summary} />
        </>
      }
      checksLabel={checksLabel}
      checksTab={checksTab}
      explanation={summary.assessment?.explanation}
      facts={when === undefined ? [kind] : [kind, when]}
      failure={failure}
      findings={
        summary.findings.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The agent reported no findings.
          </p>
        ) : (
          <ul aria-label="Findings" className="grid gap-3.5">
            {summary.findings.map((finding) => (
              <li
                className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5"
                key={finding.id}
              >
                <FindingDot outcome={finding.outcome} />
                <div className="min-w-0 space-y-1">
                  <p className="text-[13.5px] text-pretty wrap-anywhere">
                    {finding.explanation}
                  </p>
                  <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                    {assessmentOutcomeLabel[finding.outcome]} ·{" "}
                    {finding.evidence.length} evidence
                    <FindingSeek
                      at={findingMoment(summary, finding)}
                      onSeek={onSeek}
                      summary={summary}
                      videoSrc={src}
                    />
                  </p>
                  <EvidenceList evidence={finding.evidence} />
                </div>
              </li>
            ))}
          </ul>
        )
      }
      findingsCount={summary.findings.length}
      footer={
        <RunSummaryFooter id={summary.runId} kind="Run ID" links={links} />
      }
      platform={
        <>
          <GlobeIcon aria-hidden="true" />
          Web
        </>
      }
      stats={[
        { label: "Duration", value: runDuration(summary) },
        { label: "Actions", value: summary.timeline.length },
        { label: "Findings", value: summary.findings.length },
        { label: "Evidence", value: evidenceCount(summary) },
      ]}
      task={
        <>
          <RequestedTask label={taskLabel} run={summary} />
          <ReferencedFlows run={summary} />
          <Pursuits run={summary} />
          <BrowserModifications
            modifications={summary.browserModifications ?? []}
          />
          <EmulationSection run={summary} />
          <RunSummaryTaskFacts>
            {details}
            <dt>Execution</dt>
            <dd>{runOutcomeLabel[summary.outcome]}</dd>
          </RunSummaryTaskFacts>
          {summary.videoPath === null ? null : <RunVideoLocation src={src} />}
        </>
      }
      title={title}
      verdict={verdict}
      video={<SummaryVideo seekAt={seekAt} src={src} summary={summary} />}
    />
  );
};

/** A finished task Dry Run's summary, without its Flow decision. */
const DryRunSummaryLayout = ({
  links,
  result,
  summary,
  videoSrc,
}: {
  readonly links: ReactNode;
  readonly result: FlowDryRunResult | undefined;
  readonly summary: TaskDryRunSummary;
  readonly videoSrc: string | undefined;
}) => (
  <TaskRunSummaryLayout
    checks={dryRunChecks(summary)}
    checksLabel="Pass checks"
    checksTab="Pass checks"
    details={
      <>
        <dt>Flow</dt>
        <dd className="font-mono wrap-anywhere">{summary.purpose.flowName}</dd>
      </>
    }
    failure={
      dryRunFailureSentence(summary) ??
      (result?.outcome === "failed" ? result.observableOutcome : undefined)
    }
    kind="Dry Run"
    links={links}
    summary={summary}
    taskLabel="Intended outcome"
    title={summary.purpose.flowName}
    verdict={
      dryRunMissedOnlyQualifiers(summary)
        ? { label: "Dry Run did not pass", tone: "attention" }
        : dryRunSummaryVerdict(dryRunVerdict(summary, result))
    }
    videoSrc={videoSrc}
  />
);

/** How the Flow decision bar reads: a question, or where the Flow stands. */
export type FlowDecisionTone = "ask" | "failed" | "neutral" | "passed";

const flowDecisionTone: Record<FlowDecisionTone, string> = {
  ask: "",
  failed: "[--decision-tone:var(--destructive)]",
  neutral: "[--decision-tone:var(--muted-foreground)]",
  passed: "[--decision-tone:var(--status-ready)]",
};

const FlowDecisionIcon = ({ tone }: { readonly tone: FlowDecisionTone }) => {
  const className = "size-4 shrink-0 text-(--decision-tone)";
  if (tone === "passed") {
    return <CircleCheckIcon aria-hidden="true" className={className} />;
  }
  if (tone === "neutral") {
    return <CircleXIcon aria-hidden="true" className={className} />;
  }
  if (tone === "failed") {
    return <CircleAlertIcon aria-hidden="true" className={className} />;
  }
  return null;
};

/**
 * Whether the summary above the decision bar runs on below what the dock
 * shows. A marker sits at the end of the summary, just above the bar; while
 * it is out of view, the summary continues under the bar.
 */
const useSummaryContinues = () => {
  const [continuesAtom] = useState(() => Atom.make(false));
  const [continues, setContinues] = useAtom(continuesAtom);
  const [marker, setMarker] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (marker === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) {
        setContinues(!entry.isIntersecting);
      }
    });
    observer.observe(marker);
    return () => {
      observer.disconnect();
    };
  }, [marker, setContinues]);
  return [continues, setMarker] as const;
};

/**
 * The `Flow decision` region at the foot of a docked Dry Run Summary (ADR
 * 0073): one sentence on where the Flow stands, then whatever the user can
 * do about it. It is a compact solid bar that sticks to the bottom of the
 * dock, so the decision stays in reach however far the summary scrolls.
 * While the summary runs on under it, a fade over its top edge says so.
 */
export const FlowDecision = ({
  actions,
  children,
  error,
  tone,
}: {
  /** The buttons under the sentence, such as `FlowDecisionButtons`. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** A decision that could not be saved, said as an alert. */
  readonly error?: string | undefined;
  readonly tone: FlowDecisionTone;
}) => {
  const [continues, markerRef] = useSummaryContinues();
  return (
    <>
      <div aria-hidden="true" className="h-px" ref={markerRef} />
      <section
        aria-label="Flow decision"
        className={cn(
          "border-island-border bg-island-solid sticky -bottom-4 z-10 -mx-4 mt-4 -mb-4 grid gap-2 border-t px-3.5 pt-2.5 pb-3",
          continues &&
            "before:from-island-solid before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-8 before:bg-linear-to-t before:to-transparent",
          flowDecisionTone[tone]
        )}
        data-tone={tone}
      >
        <div className="flex items-start gap-2">
          <FlowDecisionIcon tone={tone} />
          <p className="text-xs/4 text-pretty" role="status">
            {children}
          </p>
        </div>
        {actions}
        {error === undefined ? null : (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
};

/** What the Flow decision's buttons do; the caller owns both mutations. */
export interface FlowDecisionActions {
  readonly onReject: () => void;
  readonly onVerify: () => void;
  /** A decision is being saved; both buttons wait for it. */
  readonly pending: boolean;
}

/** **Reject flow** and **Verify flow**, side by side at equal width. */
export const FlowDecisionButtons = ({
  onReject,
  onVerify,
  pending,
}: FlowDecisionActions) => (
  <div className="grid grid-cols-2 gap-2">
    <Button
      size="md"
      className="w-full rounded-[10px] text-[13px]"
      disabled={pending}
      onClick={onReject}
      type="button"
      variant="outline"
    >
      Reject flow
    </Button>
    <Button
      size="md"
      variant="primary"
      className="w-full rounded-[10px] text-[13px]"
      disabled={pending}
      onClick={onVerify}
      type="button"
    >
      Verify flow
    </Button>
  </div>
);

/** The question a passed Dry Run asks, naming its Flow. */
export const VerifyFlowQuestion = ({ flow }: { readonly flow: ReactNode }) => (
  <>
    <strong className="font-semibold">Verify {flow}?</strong> Verifying keeps
    the Flow and deletes its Teaching evidence.
  </>
);

/**
 * A finished task Dry Run. A Runner result of `failed` leads the Verdict tab:
 * the observable outcome is a system fact and outranks the pass checks. With
 * `decision`, a pending Flow decision closes the dock: Verify and Reject for
 * a Dry Run that passed, or why it cannot be verified.
 */
export const DryRunSummaryView = ({
  decision,
  links,
  result,
  summary,
  videoSrc,
}: {
  /**
   * The user's Verify and Reject for this Dry Run's Flow, when the Flow
   * still awaits them. Without it the summary asks nothing.
   */
  readonly decision?:
    | (FlowDecisionActions & { readonly error?: string })
    | undefined;
  readonly links?: ReactNode;
  /** The Runner's observable-outcome result, when the caller has it. */
  readonly result?: FlowDryRunResult;
  readonly summary: TaskDryRunSummary;
  readonly videoSrc?: string | undefined;
}) => {
  const view = (
    <DryRunSummaryLayout
      links={links}
      result={result}
      summary={summary}
      videoSrc={videoSrc}
    />
  );
  if (decision === undefined) {
    return view;
  }
  const passed = result?.outcome !== "failed" && dryRunChecksPass(summary);
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1">{view}</div>
      <FlowDecision
        actions={
          passed ? (
            <FlowDecisionButtons
              onReject={decision.onReject}
              onVerify={decision.onVerify}
              pending={decision.pending}
            />
          ) : null
        }
        error={decision.error}
        tone={passed ? "ask" : "failed"}
      >
        {passed ? (
          <VerifyFlowQuestion
            flow={<span className="font-mono">{summary.purpose.flowName}</span>}
          />
        ) : (
          dryRunCannotVerify
        )}
      </FlowDecision>
    </div>
  );
};

/**
 * A finished Interactive Run, laid out like a Dry Run so the two read the same
 * way. Its verdict is the Agent Assessment, and its checks are the record
 * rather than a pass rule.
 */
export const InteractiveRunSummaryView = ({
  links,
  summary,
  videoSrc,
}: {
  readonly links?: ReactNode;
  readonly summary: TaskInteractiveRunSummary;
  readonly videoSrc?: string | undefined;
}) => (
  <TaskRunSummaryLayout
    checks={interactiveRunChecks(summary)}
    checksLabel="Run checks"
    checksTab="Checks"
    details={null}
    failure={undefined}
    kind="Interactive Run"
    links={links}
    summary={summary}
    taskLabel="Requested task"
    title={summary.requestedTask}
    verdict={interactiveRunVerdict(summary)}
    videoSrc={videoSrc}
  />
);
