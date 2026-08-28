import type { FindingSeverity } from "@contingency/protocol";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const severityTone: Record<FindingSeverity, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-300",
  minor: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  moderate: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  serious: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
};

export const StepFindings = ({
  breached,
  step,
}: {
  /** Gate rules this Run breached, so a Finding can say it crossed the bar. */
  readonly breached: readonly string[];
  readonly step: TimelineStep | undefined;
}) => (
  <div className="flex min-h-0 flex-col border-l">
    <div className="px-4 py-3">
      <h3 className="text-sm font-medium">Findings at this Step</h3>
      <p className="text-muted-foreground text-xs">
        {step?.state === "done" ? `${step.findings.length} rules` : "—"}
      </p>
    </div>
    <Separator />
    <ScrollArea className="flex-1">
      <div className="space-y-2 p-3">
        {step?.state === "running" && (
          <p className="text-muted-foreground p-2 text-xs">
            Findings arrive when this Step finishes.
          </p>
        )}
        {step?.state === "pending" && (
          <p className="text-muted-foreground p-2 text-xs">Not reached yet.</p>
        )}
        {step?.state === "done" &&
          step.findings.map((finding) => (
            <article className="rounded-md border p-3" key={finding.rule}>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                    severityTone[finding.severity]
                  )}
                >
                  {finding.severity}
                </span>
                <span className="font-mono text-xs">{finding.rule}</span>
                {breached.includes(finding.rule) && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 uppercase dark:text-amber-300">
                    Gate
                  </span>
                )}
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                  {finding.nodeCount}
                </span>
              </div>
              <p className="mt-1.5 text-xs">{finding.message}</p>
            </article>
          ))}
        {step?.state === "done" && step.findings.length === 0 && (
          <p className="text-muted-foreground p-2 text-xs">
            This Step raised no Finding.
          </p>
        )}
      </div>
    </ScrollArea>
  </div>
);
