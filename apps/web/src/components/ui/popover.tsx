import {
  Popover as PopoverPrimitive,
  PopoverContent as PopoverPrimitiveContent,
  PopoverDescription as PopoverPrimitiveDescription,
  PopoverTitle as PopoverPrimitiveTitle,
  PopoverTrigger as PopoverPrimitiveTrigger,
} from "@ui-sdk/react/popover";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * UI SDK popovers render in place on the browser's top layer, so there is no
 * Portal or Positioner part. `Popover` adds no element of its own.
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive>) {
  return <PopoverPrimitive {...props} />;
}

function PopoverTrigger(
  props: React.ComponentProps<typeof PopoverPrimitiveTrigger>
) {
  return <PopoverPrimitiveTrigger {...props} />;
}

type PrimitiveAnchor = NonNullable<
  React.ComponentProps<typeof PopoverPrimitiveContent>["anchor"]
>;

/**
 * Base UI took a function that returns the anchor element. UI SDK reads any
 * object with `getBoundingClientRect()` on every position check, so the
 * function becomes one that asks for the element each time.
 */
const anchorOf = (
  anchor: PrimitiveAnchor | (() => Element | null) | undefined
): PrimitiveAnchor | null =>
  typeof anchor === "function"
    ? {
        getBoundingClientRect: () =>
          anchor()?.getBoundingClientRect() ?? new DOMRect(),
      }
    : (anchor ?? null);

function PopoverContent({
  anchor,
  className,
  positionerClassName,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitiveContent>, "anchor"> & {
  readonly anchor?: PrimitiveAnchor | (() => Element | null);
  /**
   * Kept for the Base UI facade. The top layer stacks popups by open order,
   * so a z-index no longer lifts one above another; it lands on the content.
   */
  readonly positionerClassName?: string;
  readonly className?: string;
}) {
  return (
    <PopoverPrimitiveContent
      align={align}
      anchor={anchorOf(anchor)}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 m-0 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg border-0 p-2.5 text-sm shadow-md ring-1 outline-hidden duration-100",
        positionerClassName,
        className
      )}
      {...props}
    />
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitiveTitle> & {
  readonly className?: string;
}) {
  return (
    <PopoverPrimitiveTitle className={cn("font-medium", className)} {...props} />
  );
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitiveDescription> & {
  readonly className?: string;
}) {
  return (
    <PopoverPrimitiveDescription
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
