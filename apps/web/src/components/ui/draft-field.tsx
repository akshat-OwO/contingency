"use client";

import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import type { ComponentProps } from "react";

import { Input } from "@/components/ui/input";

import { draftField } from "./draft-field-primitive";
import type { DraftFieldOptions } from "./draft-field-primitive";

export type DraftFieldProps = DraftFieldOptions &
  Omit<ComponentProps<typeof Input>, keyof DraftFieldOptions>;

const DraftField = ({
  commitOnBlur,
  debug,
  onCancel,
  onCommit,
  onEmptyCommit,
  ...inputProps
}: DraftFieldProps) => {
  const baseOptions = {
    commitOnBlur,
    onCancel,
    onCommit,
    onEmptyCommit,
  };
  const handle = usePrimitive(
    draftField,
    debug === undefined ? baseOptions : { ...baseOptions, debug }
  );

  return usePart(
    handle,
    "root",
    {},
    {
      children: <Input {...inputProps} />,
      className: "contents",
    },
    "span"
  );
};

export { DraftField };
export { draftField } from "./draft-field-primitive";
export type {
  DraftFieldCancelDetails,
  DraftFieldCancelReason,
  DraftFieldCommitDetails,
  DraftFieldCommitReason,
  DraftFieldOptions,
} from "./draft-field-primitive";
