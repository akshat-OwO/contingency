import type {
  AgentAssessmentOutcome,
  CatalogRunEntry,
} from "@contingency/protocol";

import { cn } from "@/lib/utils";

const outcomeDot: Record<AgentAssessmentOutcome | "failed" | "none", string> = {
  blocked: "bg-amber-500",
  failed: "bg-destructive",
  inconclusive: "bg-muted-foreground",
  none: "bg-muted-foreground/40",
  "not-working": "bg-destructive",
  working: "bg-emerald-500",
};

/** How a Run ended without an assessment that still says it went wrong. */
const FAILED_ENDINGS = new Set([
  "crashed",
  "interrupted",
  "process-exited",
  "timed-out",
]);

/**
 * A Run's health at a glance: its Agent Assessment, or, without one, red when
 * the Run broke off and grey when it simply went unassessed.
 */
export const OutcomeDot = ({
  className,
  run,
}: {
  readonly className?: string;
  readonly run: Pick<CatalogRunEntry, "assessment" | "outcome">;
}) => {
  const ended = FAILED_ENDINGS.has(run.outcome) ? "failed" : "none";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        outcomeDot[run.assessment ?? ended],
        className
      )}
    />
  );
};
