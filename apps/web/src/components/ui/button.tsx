import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The island surface as plain utilities, so `cn` can replace the base
 * button's edge, fill and radius instead of racing them in the cascade.
 */
const islandSurface =
  "border-island-border bg-(--island) shadow-island backdrop-blur-[18px] backdrop-saturate-[1.4] reduce-transparency:bg-island-solid reduce-transparency:backdrop-blur-none contrast-more:bg-island-solid contrast-more:border-foreground";

const buttonVariants = cva(
  "group/button focus-visible:ring-ring focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 relative inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-offset-1 active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 motion-reduce:transition-colors motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 pointer-coarse:h-10",
        icon: "size-8 pointer-coarse:size-10",
        "icon-lg": "size-9 pointer-coarse:size-10",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg pointer-coarse:size-9",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg pointer-coarse:size-8 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 pointer-coarse:h-10",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 pointer-coarse:h-9 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 pointer-coarse:h-8 [&_svg:not([class*='size-'])]:size-3",
        // Workspace home sizes (#744): a control on an island, its icon form,
        // and a full-width call to action at the foot of a start card.
        island: "h-[34px] gap-[7px] rounded-xl px-3",
        "island-icon": "size-[34px] rounded-xl",
        "island-lg": "h-10 gap-2 rounded-[13px] px-4",
        tile: "h-auto w-full justify-start rounded-[20px] p-3 text-left whitespace-normal",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive dark:bg-destructive/20 dark:hover:bg-destructive/30",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground aria-expanded:bg-secondary aria-expanded:text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        // Workspace home looks (#744). `island` is a quiet control set on an
        // island; `floating` is a pill that is its own island; `tile` is a
        // card that lifts its shadow on hover without moving.
        island:
          "text-muted-foreground hover:bg-island-hover hover:text-foreground aria-expanded:bg-island-hover aria-expanded:text-foreground bg-transparent",
        floating: `${islandSurface} text-muted-foreground hover:text-foreground rounded-full`,
        tile: `${islandSurface} text-foreground hover:shadow-island-lift focus-visible:shadow-island-lift duration-300 active:not-aria-[haspopup]:scale-100`,
      },
    },
  }
);

type ButtonProps = Omit<
  React.ComponentProps<typeof ButtonPrimitive>,
  "className" | "onClick"
> &
  VariantProps<typeof buttonVariants> & {
    readonly className?: string;
    readonly "data-slot"?: string;
    readonly onClick?: React.MouseEventHandler<HTMLButtonElement>;
  };

// UI SDK makes a button pending while a returned Promise settles, which adds
// aria-busy and aria-disabled. The facade drops the result to keep the ARIA.
function Button({
  className,
  variant = "default",
  size = "default",
  onClick,
  "data-slot": slot = "button",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      // UI SDK writes its own data-slot over a passed one, so the slot is set
      // on the rendered element to keep facades like `alert-dialog-cancel` intact.
      render={(buttonProps) => <button {...buttonProps} data-slot={slot} />}
      className={cn(buttonVariants({ className, size, variant }))}
      {...(onClick === undefined
        ? {}
        : {
            onClick: (event: React.MouseEvent<HTMLElement>) => {
              onClick(event as React.MouseEvent<HTMLButtonElement>);
            },
          })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
