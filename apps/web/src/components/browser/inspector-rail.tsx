import type { ReactNode } from "react";

import type { BrowserStreamStatus } from "@/components/browser/browser-stream-metrics";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** One tool on the inspector rail: an icon that toggles its surface. */
export const RailButton = ({
  active,
  badge,
  description,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly badge?: ReactNode;
  /** What the badge counts, read after the name by assistive technology. */
  readonly description?: string | undefined;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Toggle
          aria-description={description}
          aria-label={label}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-island-hover focus-visible:ring-ring relative grid size-9 place-items-center rounded-xl transition-[color,background-color,transform] duration-150 outline-none focus-visible:ring-2 active:scale-[0.92] disabled:opacity-40 motion-reduce:active:scale-100 pointer-coarse:size-10 [&_svg]:size-[17px]",
            // The open tool is ringed in the brand accent, as every selected
            // state in the Workspace chrome is; focus alone keeps `--ring`.
            active &&
              "text-foreground bg-brand/16 hover:bg-brand/20 shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--brand)_70%,transparent)]"
          )}
          disabled={disabled}
          onPressedChange={onClick}
          pressed={active}
          variant="unstyled"
        />
      }
    >
      {icon}
      {badge}
    </TooltipTrigger>
    <TooltipContent side="left">{label}</TooltipContent>
  </Tooltip>
);

/** A count pinned to a rail button's corner. */
export const RailBadge = ({
  children,
  tone,
}: {
  readonly children: ReactNode;
  readonly tone: "danger" | "info" | "neutral";
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "ring-island-solid absolute top-px right-px grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2",
      tone === "danger" && "bg-destructive text-white",
      tone === "info" && "bg-sky-500 text-white",
      tone === "neutral" && "bg-muted-foreground/80 text-background"
    )}
  >
    {children}
  </span>
);

/**
 * A dot pinned to a rail button's corner for a state rather than a count: a
 * live stream breathes green, one connecting is amber, and a lost one is red.
 */
export const RailDot = ({
  status,
}: {
  readonly status: BrowserStreamStatus;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "ring-island-solid absolute top-[7px] right-[7px] size-2 rounded-full ring-2",
      status === "live" && "bg-status-ready motion-safe:animate-pulse",
      status === "connecting" && "bg-brand",
      status === "lost" && "bg-destructive"
    )}
  />
);
