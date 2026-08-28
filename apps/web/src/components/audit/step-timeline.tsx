import type { RunSnapshot } from "@contingency/protocol";
import { CheckIcon, CrosshairIcon, GaugeIcon, XIcon } from "lucide-react";

import { attempts } from "@/components/audit/audit-workspace-state";
import type {
  StepState,
  TimelineStep,
} from "@/components/audit/audit-workspace-state";
import { NativeSelect } from "@/components/ui/native-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const durationSeconds = (from: string, to: string): string =>
  ((new Date(to).getTime() - new Date(from).getTime()) / 1000).toFixed(1);

const StepMarker = ({
  outcome,
  state,
}: {
  readonly outcome: "completed" | "failed" | undefined;
  readonly state: StepState;
}) => {
  if (state === "running") {
    return (
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-sky-500/20 text-sky-600">
        <Spinner className="size-3" />
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="border-muted-foreground/40 mt-0.5 size-4 shrink-0 rounded-full border border-dashed" />
    );
  }
  return (
    <span
      className={cn(
        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
        outcome === "failed"
          ? "bg-red-500/20 text-red-600"
          : "bg-emerald-500/20 text-emerald-600"
      )}
    >
      {outcome === "failed" ? (
        <XIcon className="size-3" />
      ) : (
        <CheckIcon className="size-3" />
      )}
    </span>
  );
};

export interface StepTimelineProps {
  readonly attempt: number | undefined;
  readonly onFollow: () => void;
  readonly onPin: (index: number) => void;
  readonly onSelectAttempt: (attempt: number) => void;
  readonly pinned: number | undefined;
  readonly run: RunSnapshot;
  readonly selected: number | undefined;
  readonly timeline: readonly TimelineStep[];
}

export const StepTimeline = ({
  attempt,
  onFollow,
  onPin,
  onSelectAttempt,
  pinned,
  run,
  selected,
  timeline,
}: StepTimelineProps) => {
  const live = run.phase === "running" || run.phase === "starting";
  const recorded = attempts(run);

  return (
    <div className="flex min-h-0 flex-col border-r">
      {recorded.length > 1 && (
        <div className="border-b px-3 py-2">
          <label
            className="text-muted-foreground text-xs"
            htmlFor="audit-attempt"
          >
            Attempt
          </label>
          <NativeSelect
            className="mt-1 w-full"
            id="audit-attempt"
            onChange={(event) => onSelectAttempt(Number(event.target.value))}
            value={attempt === undefined ? "" : String(attempt)}
          >
            {recorded.map((candidate) => (
              <option key={candidate.attempt} value={candidate.attempt}>
                Attempt {candidate.attempt} of {recorded.length} ·{" "}
                {candidate.outcome}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {pinned !== undefined && live && (
        <button
          className="text-muted-foreground hover:bg-muted/60 flex items-center gap-1.5 border-b px-3 py-1.5 text-left text-xs"
          onClick={onFollow}
          type="button"
        >
          <CrosshairIcon className="size-3" /> Follow the Runner
        </button>
      )}

      <ScrollArea className="flex-1">
        <ol className="p-2">
          {timeline.map((step) => (
            <li key={step.index}>
              <button
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm",
                  selected === step.index
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/60",
                  step.state === "pending" && "opacity-45"
                )}
                onClick={() => onPin(step.index)}
                type="button"
              >
                <StepMarker outcome={step.result?.outcome} state={step.state} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{step.label}</span>
                  <span className="text-muted-foreground flex items-center gap-2 font-mono text-[10px]">
                    <span>{step.type}</span>
                    {step.result !== undefined && (
                      <span>
                        {durationSeconds(
                          step.result.startedAt,
                          step.result.finishedAt
                        )}
                        s
                      </span>
                    )}
                    {step.state === "running" && (
                      <span className="text-sky-600">running</span>
                    )}
                    {step.findings.length > 0 && (
                      <span className="text-amber-600">
                        {step.findings.length} findings
                      </span>
                    )}
                    {step.result?.vitals !== undefined && (
                      <GaugeIcon className="size-3" />
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
};
