import {
  Radio as RadioPrimitive,
  RadioGroup as RadioGroupPrimitive,
  RadioIndicator as RadioIndicatorPrimitive,
} from "@ui-sdk/react/radio";
import type * as React from "react";

import { cn } from "@/lib/utils";

// UI SDK names these parts `radio-group`, `radio` and `radio-indicator`,
// which are the facade's slots, so no part needs its slot rewritten.

function RadioGroup<T extends string = string>({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive<T>>) {
  return (
    <RadioGroupPrimitive<T>
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

/** A radio button drawn as a ring, with its dot as the indicator child. */
function Radio({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioPrimitive>) {
  return (
    <RadioPrimitive
      className={cn(
        "border-input text-foreground focus-visible:ring-ring/40 data-checked:border-foreground grid size-4 shrink-0 place-items-center rounded-full border bg-transparent outline-none focus-visible:ring-3 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children ?? <RadioIndicator />}
    </RadioPrimitive>
  );
}

function RadioIndicator({
  className,
  ...props
}: React.ComponentProps<typeof RadioIndicatorPrimitive>) {
  return (
    <RadioIndicatorPrimitive
      className={cn("size-2 rounded-full bg-current", className)}
      {...props}
    />
  );
}

export { Radio, RadioGroup, RadioIndicator };
