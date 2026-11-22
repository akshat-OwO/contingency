"use client";

import {
  Toggle as TogglePrimitive,
  ToggleGroup as ToggleGroupPrimitive,
  ToggleIcon as ToggleIconPrimitive,
} from "@ui-sdk/react/toggle";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonLook = VariantProps<typeof buttonVariants>;

type ToggleProps = Omit<
  React.ComponentProps<typeof TogglePrimitive>,
  "className"
> & {
  readonly className?: string;
  readonly size?: ButtonLook["size"];
  /**
   * A Button look, or `unstyled` for a toggle that draws all of itself, like
   * an inspector rail tool. The caller styles the pressed state with
   * `data-pressed:`, since each look shows it in its own way.
   */
  readonly variant?: ButtonLook["variant"] | "unstyled";
};

/**
 * A button that stays pressed until pressed again, reporting it with
 * `aria-pressed` and `data-pressed`. Keep its name the same in both states.
 */
const Toggle = ({
  className,
  size = "island",
  variant = "island",
  ...props
}: ToggleProps) => (
  <TogglePrimitive
    className={
      variant === "unstyled"
        ? cn(className)
        : cn(buttonVariants({ className, size, variant }))
    }
    {...props}
  />
);

/**
 * Toggles that share one value: one tab stop, with arrow keys between them.
 * Name it with `aria-label`.
 */
const ToggleGroup = <T extends string = string>({
  className,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive<T>>, "className"> & {
  readonly "aria-label": string;
  readonly className?: string;
}) => <ToggleGroupPrimitive<T> className={cn("flex", className)} {...props} />;

/** An icon in a toggle, hidden from screen readers. */
const ToggleIcon = ToggleIconPrimitive;

export { Toggle, ToggleGroup, ToggleIcon };
export type {
  ToggleGroupValueChangeReason,
  TogglePressedChangeReason,
} from "@ui-sdk/react/toggle";
