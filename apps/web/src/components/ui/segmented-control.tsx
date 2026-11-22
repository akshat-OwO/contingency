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

/**
 * Keys the compact sizes keep from the browser tooling's own control, which
 * the APG radio group, and so UI SDK, leaves out: Home and End check the
 * first and last enabled segment, and Enter presses the focused one, as it
 * did when the segments were plain buttons. The island look keeps UI SDK's
 * Enter, which submits a surrounding form. Pressing a segment checks it the
 * way a click does. It runs as the key goes down to the segment, before UI
 * SDK's own Enter handling there; a consumer's `onKeyDownCapture` can still
 * cancel it.
 */
const pressSegmentFor = (
  event: React.KeyboardEvent<HTMLDivElement>,
  size: SegmentedControlSize
) => {
  if (event.defaultPrevented || size === "default") {
    return;
  }
  const enabled = '[data-slot="segmented-control-item"]:not([data-disabled])';
  let target: HTMLElement | null | undefined;
  if (event.key === "Home" || event.key === "End") {
    const segments = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(enabled),
    ];
    target = event.key === "Home" ? segments.at(0) : segments.at(-1);
  } else if (event.key === "Enter" && event.target instanceof HTMLElement) {
    target = event.target.closest<HTMLElement>(enabled);
  }
  if (target === null || target === undefined) {
    return;
  }
  event.preventDefault();
  target.focus();
  target.click();
};

/**
 * One choice of a few, drawn as a row of segments with a raised thumb that
 * slides to the checked one. It is a radio group to assistive technology:
 * one tab stop, and the arrow keys move and check. The compact sizes add
 * Home, End and Enter. Name it with `aria-label` or a Field label.
 *
 * Pass `value={null}`, not `undefined`, while nothing is checked, so the
 * control stays controlled. A click never unchecks a segment, but a
 * `controller` can, so `onValueChange` hears `null` then.
 */
const SegmentedControl = <T extends string = string>({
  className,
  children,
  onKeyDownCapture,
  size = "default",
  ...props
}: Omit<
  React.ComponentProps<typeof SegmentedControlPrimitive<T>>,
  "children"
> & {
  readonly children?: React.ReactNode;
  readonly size?: SegmentedControlSize;
}) => (
  <SegmentedControlPrimitive<T>
    className={cn(segmentedControlVariants({ size }), className)}
    data-size={size}
    onKeyDownCapture={(event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDownCapture?.(event);
      pressSegmentFor(event, size);
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
// A controller checks or clears a segment from outside the control.
export { createSegmentedControlController } from "@ui-sdk/react/segmented-control";
export type { SegmentedControlController } from "@ui-sdk/react/segmented-control";
