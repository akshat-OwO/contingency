import {
  FileInput as FileInputPrimitive,
  FileInputDropzone as FileInputDropzonePrimitive,
  FileInputTrigger as FileInputTriggerPrimitive,
} from "@ui-sdk/react/file-input";
import type * as React from "react";

import { cn } from "@/lib/utils";

// UI SDK names these parts `file-input`, `file-input-dropzone` and
// `file-input-trigger`, which are the facade's slots. The root renders the
// hidden native file input, which stays out of the tab order and the
// accessibility tree; the trigger is what people use.

const FileInput = (props: React.ComponentProps<typeof FileInputPrimitive>) => (
  <FileInputPrimitive {...props} />
);

/** Where a file can be dropped or pasted. Keep a trigger inside it. */
const FileInputDropzone = ({
  className,
  ...props
}: React.ComponentProps<typeof FileInputDropzonePrimitive>) => (
  <FileInputDropzonePrimitive
    className={cn(
      "border-island-border data-drag-accept:border-foreground/40 data-drag-accept:bg-island-hover data-drag-reject:border-destructive flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-xl border border-dashed px-3 py-3 text-[13px] data-disabled:opacity-50",
      className
    )}
    {...props}
  />
);

const FileInputTrigger = (
  props: React.ComponentProps<typeof FileInputTriggerPrimitive>
) => <FileInputTriggerPrimitive {...props} />;

export { FileInput, FileInputDropzone, FileInputTrigger };

/**
 * A chosen file's path inside its folder, starting at the folder: from the
 * picker's `webkitRelativePath`, or from where a dropped folder held it.
 */
// oxlint-disable-next-line react-doctor/only-export-components -- Feature code reads paths through the facade, never from UI SDK.
export { relativePath } from "@ui-sdk/react/file-input";
