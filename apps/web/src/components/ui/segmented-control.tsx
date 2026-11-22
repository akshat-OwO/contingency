import {
  SegmentedControl as SegmentedControlPrimitive,
  SegmentedControlIndicator as SegmentedControlIndicatorPrimitive,
  SegmentedControlItem as SegmentedControlItemPrimitive,
} from "@ui-sdk/react/segmented-control";
import { cva } from "class-variance-authority";
import { createContext, use } from "react";
import type * as React from "react";

import { cn } from "@/lib/utils";

// UI SDK names these parts `segmented-control`, `segmented-control-item` and
// `segmented-control-indicator`, which are the facade's slots.

/**
 * `default` is the island look. `sm` and `xs` are the compact looks of the
 * browser and device tooling, where the control sits in a dense toolbar or
 * panel row; `xs` is for one- or two-character choices such as `2×`.
 */
type SegmentedControlSize = "default" | "sm" | "xs";

const SegmentedControlSizeContext =
  createContext<SegmentedControlSize>("default");

const segmentedControlVariants = cva(
  "relative isolate inline-flex shrink-0 data-disabled:opacity-50",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        default:
          "bg-island-hover rounded-[10px] p-0.5 shadow-[inset_0_0_0_1px_var(--island-border)]",
        sm: "bg-muted/70 items-center gap-0.5 rounded-lg p-0.5",
        xs: "bg-muted/70 items-center gap-0.5 rounded-lg p-0.5",
      },
    },
  }
);

const segmentedControlIndicatorVariants = cva(
  "absolute top-(--segmented-control-indicator-top) left-(--segmented-control-indicator-left) -z-10 h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) transition-[left,width] ease-out motion-reduce:transition-none",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        default:
          "bg-island-solid rounded-lg shadow-[0_1px_2px_oklch(0_0_0/0.12),inset_0_0_0_1px_var(--island-border)] duration-200",
        sm: "bg-background rounded-md shadow-xs duration-150 dark:bg-white/10",
        xs: "bg-background rounded-md shadow-xs duration-150 dark:bg-white/10",
      },
    },
  }
);

const segmentedControlItemVariants = cva(
  "text-muted-foreground hover:text-foreground data-checked:text-foreground font-medium outline-none focus-visible:ring-2 data-disabled:pointer-events-none",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        default: "focus-visible:ring-ring/40 h-7 rounded-lg px-2.5 text-xs",
        sm: "focus-visible:ring-ring inline-flex h-6 items-center justify-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap transition-[color,box-shadow,scale] duration-150 active:scale-[0.97] motion-reduce:transition-colors motion-reduce:active:scale-100 pointer-coarse:h-9 pointer-coarse:px-3",
        xs: "focus-visible:ring-ring inline-flex h-5 items-center justify-center gap-1.5 rounded-md px-1 text-xs whitespace-nowrap transition-[color,box-shadow,scale] duration-150 active:scale-[0.97] motion-reduce:transition-colors motion-reduce:active:scale-100 pointer-coarse:h-9 pointer-coarse:min-w-9",
      },
    },
  }
);

type PrimitiveProps<T extends string> = React.ComponentProps<
  typeof SegmentedControlPrimitive<T>
>;

type ValueChangeDetails<T extends string> = Parameters<
  NonNullable<PrimitiveProps<T>["onValueChange"]>
>[1];

/**
 * Home and End check the first and last enabled segment. The APG radio group
 * leaves them out, so UI SDK does too, but the browser tooling's controls have
 * always had them. Pressing the segment checks it the way a click does.
 */
const checkEdgeSegment = (event: React.KeyboardEvent<HTMLDivElement>) => {
  if (event.defaultPrevented || (event.key !== "Home" && event.key !== "End")) {
    return;
  }
  const segments = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[data-slot="segmented-control-item"]:not([data-disabled])'
    ),
  ];
  const target = event.key === "Home" ? segments.at(0) : segments.at(-1);
  if (target === undefined) {
    return;
  }
  event.preventDefault();
  target.focus();
  target.click();
};

/**
 * One choice of a few, drawn as a row of segments with a raised thumb that
 * slides to the checked one. It is a radio group to assistive technology:
 * one tab stop, and the arrow keys, Home and End move and check. Name it with `aria-label`
 * or a Field label.
 *
 * Pass `value={null}`, not `undefined`, while nothing is checked, so the
 * control stays controlled. A segment can't be unchecked, so `onValueChange`
 * only ever hears a value.
 */
const SegmentedControl = <T extends string = string>({
  className,
  children,
  onKeyDown,
  onValueChange,
  size = "default",
  ...props
}: Omit<PrimitiveProps<T>, "children" | "onValueChange"> & {
  readonly children?: React.ReactNode;
  readonly onValueChange?: (value: T, details: ValueChangeDetails<T>) => void;
  readonly size?: SegmentedControlSize;
}) => (
  <SegmentedControlPrimitive<T>
    className={cn(segmentedControlVariants({ size }), className)}
    data-size={size}
    onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      checkEdgeSegment(event);
    }}
    onValueChange={(next, details) => {
      if (next !== null) {
        onValueChange?.(next, details);
      }
    }}
    {...props}
  >
    {() => (
      <SegmentedControlSizeContext value={size}>
        <SegmentedControlIndicatorPrimitive
          className={segmentedControlIndicatorVariants({ size })}
        />
        {children}
      </SegmentedControlSizeContext>
    )}
  </SegmentedControlPrimitive>
);

/** One segment. Its text, and any count in it, is its accessible name. */
const SegmentedControlItem = ({
  className,
  ...props
}: React.ComponentProps<typeof SegmentedControlItemPrimitive>) => {
  const size = use(SegmentedControlSizeContext);
  return (
    <SegmentedControlItemPrimitive
      className={cn(segmentedControlItemVariants({ size }), className)}
      {...props}
    />
  );
};

/** A quiet tally after a segment's label, such as the errors in a log. */
const SegmentedControlCount = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn("text-muted-foreground tabular-nums", className)}
    data-slot="segmented-control-count"
    {...props}
  />
);

export { SegmentedControl, SegmentedControlCount, SegmentedControlItem };
export type { SegmentedControlSize };
