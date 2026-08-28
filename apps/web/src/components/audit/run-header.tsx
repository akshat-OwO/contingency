import type { RunSnapshot } from "@contingency/protocol";
import { PlayIcon, ShieldAlertIcon } from "lucide-react";

import {
  gateBreach,
  runProgress,
  stepsDone,
} from "@/components/audit/audit-workspace-state";
import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import { FlowUpload } from "@/components/audit/flow-upload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface RunHeaderProps {
  readonly busy: boolean;
  readonly onLoadFlow: (document: string, source: string) => void;
  readonly onStart: () => void;
  readonly run: RunSnapshot;
  readonly timeline: readonly TimelineStep[];
}

const PhaseBadge = ({
  done,
  run,
  total,
}: {
  readonly done: number;
  readonly run: RunSnapshot;
  readonly total: number;
}) => {
  if (run.phase === "starting") {
    return (
      <Badge className="gap-1.5" variant="secondary">
        <Spinner className="size-3" /> Starting
      </Badge>
    );
  }
  if (run.phase === "running") {
    return (
      <Badge className="gap-1.5" variant="secondary">
        <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
        Running · step {Math.min(done + 1, total)} of {total}
        {run.attempt === undefined || run.attempt === 1
          ? null
          : ` · attempt ${run.attempt} of ${run.attemptCeiling}`}
      </Badge>
    );
  }
  if (run.phase === "finished") {
    return (
      <Badge variant={run.outcome === "failed" ? "destructive" : "secondary"}>
        {run.outcome === "failed" ? "Failed" : "Completed"}
      </Badge>
    );
  }
  return <Badge variant="outline">Not started</Badge>;
};

export const RunHeader = ({
  busy,
  onLoadFlow,
  onStart,
  run,
  timeline,
}: RunHeaderProps) => {
  const live = run.phase === "running" || run.phase === "starting";
  const done = stepsDone(timeline);
  const breached = gateBreach(run);

  return (
    <header className="relative flex items-center gap-3 border-b px-4 py-2">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold">{run.flow.title}</h1>
        <p className="text-muted-foreground font-mono text-[11px]">
          {run.run === null ? "No Run yet" : run.run.runId}
        </p>
      </div>

      <PhaseBadge done={done} run={run} total={timeline.length} />

      {/*
        Outcome and Gate are separate verdicts and are shown as separate
        indicators: a breach is the site missing a bar its author chose, never
        a failed Run, and a breaching Run stays Baseline-eligible (ADR 0018).
      */}
      {breached === undefined ? null : (
        <Badge className="gap-1.5" variant="outline">
          <ShieldAlertIcon className="size-3.5 text-amber-600" />
          Gate breached · {breached.join(", ")}
        </Badge>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* One Flow at a time still: this replaces the loaded one. */}
        <FlowUpload
          busy={busy || live}
          label="Open a Flow"
          onLoad={onLoadFlow}
        />
        <Button disabled={live || busy} onClick={onStart} size="sm">
          <PlayIcon className="size-3.5" />
          {run.run === null ? "Run Flow" : "Run again"}
        </Button>
      </div>

      {/* The Run's advance, without stealing header room. */}
      {live && (
        <span
          className="absolute right-0 bottom-0 left-0 h-0.5 bg-sky-500 transition-[width] duration-200"
          style={{ width: `${runProgress(timeline) * 100}%` }}
        />
      )}
    </header>
  );
};
