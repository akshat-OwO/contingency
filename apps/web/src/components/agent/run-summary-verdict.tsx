import { CircleAlertIcon, CircleCheckIcon, CircleXIcon } from "lucide-react";

import type {
  SummaryVerdict,
  SummaryVerdictTone,
} from "@/components/agent/dry-run-summary-state";
import { cn } from "@/lib/utils";

/**
 * Each verdict tone as a colour token, so the card, the chip, and the check
 * marks tint from one value in light and dark.
 */
const verdictToneVariable: Record<SummaryVerdictTone, string> = {
  attention: "[--verdict-tone:var(--status-needs-you)]",
  failed: "[--verdict-tone:var(--destructive)]",
  passed: "[--verdict-tone:var(--status-ready)]",
};

export const VerdictIcon = ({
  className,
  tone,
}: {
  readonly className?: string;
  readonly tone: SummaryVerdictTone;
}) => {
  if (tone === "passed") {
    return <CircleCheckIcon aria-hidden="true" className={className} />;
  }
  if (tone === "failed") {
    return <CircleXIcon aria-hidden="true" className={className} />;
  }
  return <CircleAlertIcon aria-hidden="true" className={className} />;
};

/** The verdict as a small chip, for the collapsed dock. */
export const VerdictChip = ({
  verdict,
}: {
  readonly verdict: SummaryVerdict;
}) => (
  <span
    className={cn(
      "status-chip h-[22px] [--status-tone:var(--verdict-tone)] [&_svg]:size-3",
      verdictToneVariable[verdict.tone]
    )}
    data-slot="verdict-chip"
    data-tone={verdict.tone}
  >
    <VerdictIcon tone={verdict.tone} />
    {verdict.label}
  </span>
);

/**
 * The card a Run Summary opens on: the verdict in its tone, and under it the
 * platform, the kind of Run, and when. Every summary surface shares it, so a
 * browser Run, a device Run, and a catalog entry read the same way.
 */
export const VerdictCard = ({
  facts,
  platform,
  verdict,
}: {
  /** The facts under the verdict, such as the kind of Run and when. */
  readonly facts: readonly string[];
  /** The platform, with its icon, before the facts. */
  readonly platform?: React.ReactNode;
  readonly verdict: SummaryVerdict;
}) => (
  <div
    className={cn(
      "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-[color-mix(in_oklch,var(--verdict-tone)_9%,transparent)] py-3 pr-3.5 pl-3 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--verdict-tone)_20%,transparent)]",
      verdictToneVariable[verdict.tone]
    )}
    data-slot="verdict-card"
    data-tone={verdict.tone}
  >
    <span className="grid size-9 place-items-center rounded-xl bg-[color-mix(in_oklch,var(--verdict-tone)_15%,transparent)] text-(--verdict-tone)">
      <VerdictIcon className="size-5" tone={verdict.tone} />
    </span>
    <div className="min-w-0">
      <p className="text-base font-semibold tracking-[-0.015em] text-[color-mix(in_oklch,var(--verdict-tone)_78%,var(--foreground))]">
        {verdict.label}
      </p>
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-[12.5px] [&_svg]:size-3.5">
        {platform === undefined ? null : (
          <span className="inline-flex items-center gap-1">{platform}</span>
        )}
        {facts.map((fact, index) => (
          <span className="inline-flex items-center gap-1.5" key={fact}>
            {index === 0 && platform === undefined ? null : (
              <span aria-hidden="true">·</span>
            )}
            {fact}
          </span>
        ))}
      </p>
    </div>
  </div>
);
