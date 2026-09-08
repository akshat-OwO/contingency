import { UploadIcon } from "lucide-react";
import type { ChangeEvent } from "react";
import { useId } from "react";

import { buttonVariants } from "@/components/ui/button";

export interface FlowUploadProps {
  readonly busy: boolean;
  readonly label: string;
  /** The document's text and the file's name, which only names decode errors. */
  readonly onLoad: (document: string, source: string) => void;
  readonly size?: "default" | "sm";
  readonly variant?: "default" | "outline";
}

/**
 * Hands a Flow file to the server from the browser, for the reader who has the
 * file in front of them rather than on the path the process was started with.
 * The file is read here and its text travels in the request, so the server is
 * never handed a path to open.
 */
export const FlowUpload = ({
  busy,
  label,
  onLoad,
  size = "sm",
  variant = "outline",
}: FlowUploadProps) => {
  const inputId = useId();

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared either way, so choosing the same file twice still fires.
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    onLoad(await file.text(), file.name);
  };

  return (
    <label
      className={buttonVariants({ size, variant })}
      data-disabled={busy || undefined}
      htmlFor={inputId}
    >
      <UploadIcon className="size-3.5" />
      {label}
      <input
        accept=".json,application/json"
        className="sr-only"
        disabled={busy}
        id={inputId}
        onChange={(event) => {
          void onChange(event);
        }}
        type="file"
      />
    </label>
  );
};
