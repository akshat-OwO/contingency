import {
  Field as FieldPrimitive,
  FieldDescription as FieldDescriptionPrimitive,
  FieldError as FieldErrorPrimitive,
  FieldLabel as FieldLabelPrimitive,
} from "@ui-sdk/react/field";
import type * as React from "react";

import { cn } from "@/lib/utils";

const Field = ({
  className,
  ...props
}: React.ComponentProps<typeof FieldPrimitive>) => (
  <FieldPrimitive
    className={cn(
      "group/field flex w-full flex-col gap-2 *:w-full [&>.sr-only]:w-auto",
      className
    )}
    {...props}
  />
);

const FieldLabel = ({
  className,
  ...props
}: React.ComponentProps<typeof FieldLabelPrimitive>) => (
  <FieldLabelPrimitive
    className={cn(
      "flex w-fit items-center gap-2 text-sm leading-snug font-medium select-none data-disabled:opacity-50",
      className
    )}
    {...props}
  />
);

const FieldDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof FieldDescriptionPrimitive>) => (
  <FieldDescriptionPrimitive
    className={cn(
      "text-muted-foreground text-left text-sm leading-normal font-normal",
      className
    )}
    {...props}
  />
);

// Show an error by passing `invalid` to its Field. `match` would show it too,
// but in 0.1.0-beta.5 it gives the error a fresh id that aria-describedby misses.
const FieldError = ({
  className,
  ...props
}: React.ComponentProps<typeof FieldErrorPrimitive>) => (
  <FieldErrorPrimitive
    className={cn("text-destructive text-sm font-normal", className)}
    role="alert"
    {...props}
  />
);

export { Field, FieldDescription, FieldError, FieldLabel };
