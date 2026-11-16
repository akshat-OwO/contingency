import { Input as InputPrimitive } from "@ui-sdk/react/input";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A filled field on a Workspace home island (#744). Opt in with
 * `variant="island"`; the default look is unchanged.
 */
const islandInputClassName =
  "border-island-border bg-island-hover h-[38px] rounded-xl px-3 text-sm hover:border-island-border focus-visible:border-[#ffc400] focus-visible:ring-[oklch(0.85_0.17_85/0.25)] dark:bg-island-hover";

function Input({
  className,
  type,
  variant = "default",
  "data-slot": slot = "input",
  ...props
}: React.ComponentProps<typeof InputPrimitive> & {
  readonly "data-slot"?: string;
  readonly variant?: "default" | "island";
}) {
  return (
    <InputPrimitive
      type={type}
      // UI SDK writes its own data-slot over a passed one, so the slot is set
      // on the rendered element to keep `input-group-control` intact.
      render={(inputProps) => <input {...inputProps} data-slot={slot} />}
      className={cn(
        "border-input file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_15%)] focus-visible:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm",
        variant === "island" && islandInputClassName,
        className
      )}
      {...props}
    />
  );
}

export { Input };
