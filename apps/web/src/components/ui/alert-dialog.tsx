import {
  AlertDialog as AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogPrimitiveBackdrop,
  AlertDialogClose as AlertDialogPrimitiveClose,
  AlertDialogContent as AlertDialogPrimitiveContent,
  AlertDialogDescription as AlertDialogPrimitiveDescription,
  AlertDialogTitle as AlertDialogPrimitiveTitle,
  AlertDialogTrigger as AlertDialogPrimitiveTrigger,
} from "@ui-sdk/react/alert-dialog";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ClassName {
  readonly className?: string;
}

/**
 * On UI SDK, like Dialog, so a confirmation opened from inside a Dialog joins
 * the same top layer and stacks above it. A body-portalled confirmation would
 * sit below the Dialog and inside its inert page.
 */
const AlertDialog = (
  props: React.ComponentProps<typeof AlertDialogPrimitive>
) => <AlertDialogPrimitive {...props} />;

const AlertDialogTrigger = (
  props: React.ComponentProps<typeof AlertDialogPrimitiveTrigger>
) => (
  <AlertDialogPrimitiveTrigger
    render={<button data-slot="alert-dialog-trigger" />}
    {...props}
  />
);

/**
 * UI SDK alert dialogs render in place on the top layer, so a portal has
 * nothing to do. Kept so the facade's export names stay stable.
 */
const AlertDialogPortal = ({
  children,
}: {
  readonly children?: React.ReactNode;
}) => children;

const AlertDialogOverlay = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitiveBackdrop> & ClassName) => (
  <AlertDialogPrimitiveBackdrop
    render={<div data-slot="alert-dialog-overlay" />}
    className={cn(
      "data-open:animate-in data-open:fade-in-0 data-ending-style:animate-out data-ending-style:fade-out-0 fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs",
      className
    )}
    {...props}
  />
);

const AlertDialogContent = ({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitiveContent> &
  ClassName & {
    readonly children?: React.ReactNode;
    size?: "default" | "sm";
  }) => (
  <>
    <AlertDialogOverlay />
    <AlertDialogPrimitiveContent
      render={<div data-slot="alert-dialog-content" data-size={size} />}
      className={cn(
        "group/alert-dialog-content bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 fixed top-1/2 left-1/2 z-50 m-0 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border-0 p-4 ring-1 duration-100 outline-none data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm",
        className
      )}
      {...props}
    >
      {children}
    </AlertDialogPrimitiveContent>
  </>
);

const AlertDialogHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    data-slot="alert-dialog-header"
    className={cn(
      "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
      className
    )}
    {...props}
  />
);

const AlertDialogFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    data-slot="alert-dialog-footer"
    className={cn(
      "bg-muted/50 -mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t p-4 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
);

const AlertDialogMedia = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    data-slot="alert-dialog-media"
    className={cn(
      "bg-muted mb-2 inline-flex size-10 items-center justify-center rounded-md sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
      className
    )}
    {...props}
  />
);

const AlertDialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitiveTitle> & ClassName) => (
  <AlertDialogPrimitiveTitle
    render={<h2 data-slot="alert-dialog-title" />}
    className={cn(
      "font-heading text-base font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
      className
    )}
    {...props}
  />
);

const AlertDialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitiveDescription> &
  ClassName) => (
  <AlertDialogPrimitiveDescription
    render={<p data-slot="alert-dialog-description" />}
    className={cn(
      "text-muted-foreground *:[a]:hover:text-foreground text-sm text-balance md:text-pretty *:[a]:underline *:[a]:underline-offset-3",
      className
    )}
    {...props}
  />
);

const AlertDialogAction = ({
  className,
  ...props
}: React.ComponentProps<typeof Button>) => (
  <Button
    size="md"
    variant="primary"
    data-slot="alert-dialog-action"
    className={cn(className)}
    {...props}
  />
);

const AlertDialogCancel = ({
  className,
  variant = "outline",
  size = "md",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitiveClose> &
  ClassName &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) => (
  <AlertDialogPrimitiveClose
    render={
      <Button data-slot="alert-dialog-cancel" variant={variant} size={size} />
    }
    className={cn(className)}
    {...props}
  />
);

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
