import type {
  AgentAssessmentOutcome,
  CatalogRunEntry,
} from "@contingency/protocol";

import { runVerdict } from "@/components/catalog/flows-format";
import { cn } from "@/lib/utils";

/** Each outcome's tone, as the prototype's assessment chips colour them. */
const outcomeTone: Record<AgentAssessmentOutcome | "failed" | "none", string> =
  {
    blocked: "[--status-tone:var(--status-needs-you)]",
    failed: "[--status-tone:var(--destructive)]",
    inconclusive: "[--status-tone:var(--muted-foreground)]",
    none: "[--status-tone:var(--muted-foreground)]",
    "not-working": "[--status-tone:var(--destructive)]",
    working: "[--status-tone:var(--status-ready)]",
  };

/** How a Run ended without an assessment that still says it went wrong. */
const FAILED_ENDINGS = new Set([
  "crashed",
  "interrupted",
  "process-exited",
  "timed-out",
]);

/**
 * A Run's health at a glance, as a tinted chip: its Agent Assessment, or,
 * without one, how it ended, red when the Run broke off and grey when it
 * simply went unassessed.
 */
export const OutcomeChip = ({
  className,
  run,
}: {
  readonly className?: string;
  readonly run: Pick<CatalogRunEntry, "assessment" | "outcome">;
}) => {
  const ended = FAILED_ENDINGS.has(run.outcome) ? "failed" : "none";
  return (
    <span
      className={cn(
        "status-chip max-w-full min-w-0",
        outcomeTone[run.assessment ?? ended],
        className
      )}
    >
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 rounded-full bg-current"
      />
      <span className="min-w-0 truncate">{runVerdict(run)}</span>
    </span>
  );
};
