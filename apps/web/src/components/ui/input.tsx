import { Input as InputPrimitive } from "@ui-sdk/react/input";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The taller field on an island (#744), with the amber focus edge. It is the
 * default; `variant="compact"` keeps the 32px field for dense panels.
 */
const islandInputClassName =
  "border-island-border bg-island-hover h-[38px] rounded-xl px-3 text-sm hover:border-island-border focus-visible:border-[#ffc400] focus-visible:ring-[oklch(0.85_0.17_85/0.25)] dark:bg-island-hover";

const Input = ({
  className,
  type,
  variant = "island",
  "data-slot": slot = "input",
  ...props
}: React.ComponentProps<typeof InputPrimitive> & {
  readonly "data-slot"?: string;
  readonly variant?: "compact" | "island";
}) => (
  <InputPrimitive
    type={type}
    // UI SDK writes its own data-slot over a passed one, so the slot is set
    // on the rendered element to keep `input-group-control` intact.
    render={(inputProps) => <input {...inputProps} data-slot={slot} />}
    // A filled field (#744): the tint carries the field and a faint edge
    // frames it. More contrast restores the 3:1 `--input` edge. The size is
    // one plain class, so a caller's `text-xs` wins at every width.
    className={cn(
      "border-island-border bg-island-hover file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 contrast-more:border-input h-8 w-full min-w-0 rounded-lg border px-2.5 py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium hover:border-[color-mix(in_oklch,var(--island-border),var(--foreground)_10%)] focus-visible:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3",
      variant === "island" && islandInputClassName,
      className
    )}
    {...props}
  />
);

export { Input };
