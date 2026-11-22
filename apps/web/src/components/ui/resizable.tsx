"use client";

import {
  Resizable as ResizablePrimitive,
  ResizableHandle as ResizableHandlePrimitive,
  ResizablePanel as ResizablePanelPrimitive,
} from "@ui-sdk/react/resizable";
import type * as React from "react";

import { cn } from "@/lib/utils";

/** The parts accept a class list only, never a function of their state. */
type Styled<P> = Omit<P, "className"> & { readonly className?: string };

/**
 * A group of panels split by handles. UI SDK lays the panels out in a flex row
 * or column and sizes each as a percentage of the room they share.
 */
const Resizable = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ResizablePrimitive>>) => (
  <ResizablePrimitive className={cn("min-h-0 min-w-0", className)} {...props} />
);

const ResizablePanel = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ResizablePanelPrimitive>>) => (
  <ResizablePanelPrimitive
    className={cn("min-h-0 min-w-0", className)}
    {...props}
  />
);

/**
 * How a handle draws itself. A `pill` is the Workspace's grip between the
 * stage and DevTools, shown only on hover, drag or focus. A `hairline` is the
 * line between two panes inside an island.
 */
type ResizableHandleVariant = "hairline" | "pill";

const handleIndicator: Readonly<Record<ResizableHandleVariant, string>> = {
  hairline:
    "bg-border group-data-[hovering]/resize:bg-ring/60 group-data-[dragging]/resize:bg-ring/60 group-focus-visible/resize:bg-ring group-data-[orientation=horizontal]/resize:h-full group-data-[orientation=horizontal]/resize:w-px group-data-[orientation=vertical]/resize:h-px group-data-[orientation=vertical]/resize:w-full",
  pill: "rounded-full bg-transparent group-data-[hovering]/resize:bg-brand/60 group-data-[dragging]/resize:bg-brand/60 group-focus-visible/resize:bg-ring group-data-[orientation=horizontal]/resize:h-10 group-data-[orientation=horizontal]/resize:w-1 group-data-[orientation=vertical]/resize:h-1 group-data-[orientation=vertical]/resize:w-10",
};

/**
 * The focusable separator between two panels. Name it with `aria-label`. Its
 * hit area reaches past a thin handle, and `data-hovering` covers all of it.
 */
const ResizableHandle = ({
  className,
  variant = "hairline",
  ...props
}: Omit<
  Styled<React.ComponentProps<typeof ResizableHandlePrimitive>>,
  "children"
> & {
  readonly "aria-label": string;
  readonly variant?: ResizableHandleVariant;
}) => (
  <ResizableHandlePrimitive
    className={cn(
      "group/resize relative z-10 flex items-center justify-center outline-none data-[orientation=horizontal]:cursor-col-resize data-[orientation=vertical]:cursor-row-resize",
      className
    )}
    data-variant={variant}
    {...props}
  >
    <span
      aria-hidden="true"
      className={cn("transition-colors", handleIndicator[variant])}
    />
  </ResizableHandlePrimitive>
);

export { Resizable, ResizableHandle, ResizablePanel };
export type { ResizableHandleVariant };
export type {
  ResizableLayoutChangeDetails,
  ResizableLayoutCommitDetails,
} from "@ui-sdk/react/resizable";
