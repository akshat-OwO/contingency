import type { ReactNode } from "react";

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
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly badge?: ReactNode;
  /** What the badge counts, read after the name by assistive technology. */
  readonly description?: string | undefined;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          aria-description={description}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 relative grid size-9 place-items-center rounded-xl transition-[color,background-color,transform] duration-150 outline-none focus-visible:ring-2 active:scale-95 [&_svg]:size-4",
            active &&
              "bg-foreground text-background hover:bg-foreground hover:text-background"
          )}
          onClick={onClick}
          type="button"
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
      "ring-background absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.625rem] leading-none font-semibold tabular-nums ring-2",
      tone === "danger" && "bg-destructive text-white",
      tone === "info" && "bg-sky-500 text-white",
      tone === "neutral" && "bg-muted-foreground/80 text-background"
    )}
  >
    {children}
  </span>
);
