import {
  SegmentedControl as SegmentedControlPrimitive,
  SegmentedControlIndicator as SegmentedControlIndicatorPrimitive,
  SegmentedControlItem as SegmentedControlItemPrimitive,
} from "@ui-sdk/react/segmented-control";
import type * as React from "react";

import { cn } from "@/lib/utils";

// UI SDK names these parts `segmented-control`, `segmented-control-item` and
// `segmented-control-indicator`, which are the facade's slots.

/**
 * One choice of a few, drawn as a row of segments with a raised thumb that
 * slides to the checked one. It is a radio group to assistive technology.
 */
function SegmentedControl<T extends string = string>({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SegmentedControlPrimitive<T>>) {
  return (
    <SegmentedControlPrimitive<T>
      className={cn(
        "bg-island-hover relative isolate inline-flex shrink-0 rounded-[10px] p-0.5 shadow-[inset_0_0_0_1px_var(--island-border)] data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SegmentedControlIndicatorPrimitive className="bg-island-solid absolute top-(--segmented-control-indicator-top) left-(--segmented-control-indicator-left) -z-10 h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) rounded-lg shadow-[0_1px_2px_oklch(0_0_0/0.12),inset_0_0_0_1px_var(--island-border)] transition-[left,width] duration-200 ease-out motion-reduce:transition-none" />
      {children}
    </SegmentedControlPrimitive>
  );
}

function SegmentedControlItem({
  className,
  ...props
}: React.ComponentProps<typeof SegmentedControlItemPrimitive>) {
  return (
    <SegmentedControlItemPrimitive
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 data-checked:text-foreground h-7 rounded-lg px-2.5 text-xs font-medium outline-none focus-visible:ring-2 data-disabled:pointer-events-none",
        className
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
