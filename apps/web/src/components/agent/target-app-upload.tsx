import { useAtom } from "@effect/atom-react";
import { Effect, Fiber } from "effect";
import { Atom } from "effect/reactivity";
import { LoaderCircleIcon, PackageIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AppBundleFile, TargetAppBuildUploadError } from "@/lib/rpc";
import { cn } from "@/lib/utils";

export type BuildUploadState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "uploading"; readonly name: string }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Runs one upload at a time. A newer upload, or unmounting, interrupts the
 * one before it, so only the latest choice can become the Target App.
 */
export const useBuildUpload = <Input, Uploaded>(
  upload: (input: Input) => Effect.Effect<Uploaded, TargetAppBuildUploadError>,
  onUploaded: (uploaded: Uploaded) => void
) => {
  const [stateAtom] = useState(() =>
    Atom.make<BuildUploadState>({ _tag: "idle" })
  );
  const [state, setState] = useAtom(stateAtom);
  const running = useRef<Fiber.Fiber<unknown> | null>(null);
  const stop = () => {
    if (running.current !== null) {
      Effect.runFork(Fiber.interrupt(running.current));
      running.current = null;
    }
  };
  useEffect(() => stop, []);
  const start = (input: Input, name: string) => {
    stop();
    setState({ _tag: "uploading", name });
    running.current = Effect.runFork(
      upload(input).pipe(
        Effect.match({
          onFailure: (cause) =>
            setState({ _tag: "failed", message: cause.message }),
          onSuccess: (uploaded) => {
            setState({ _tag: "idle" });
            onUploaded(uploaded);
          },
        })
      )
    );
  };
  const reset = () => {
    stop();
    setState({ _tag: "idle" });
  };
  return { reset, start, state };
};

/**
 * A button that opens the file picker. For an iOS `.app`, the picker
 * chooses a folder; for Android, one `.apk`.
 */
export const BuildPicker = ({
  accept,
  describedBy,
  directory,
  disabled = false,
  label,
  onFiles,
  state,
}: {
  readonly accept?: string;
  readonly describedBy: string;
  readonly directory: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onFiles: (files: readonly AppBundleFile[], name: string) => void;
  readonly state: BuildUploadState;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const uploading = state._tag === "uploading";
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <input
        accept={accept}
        aria-hidden="true"
        // Names the hidden picker for automation; the button is what people use.
        aria-label={label}
        className="hidden"
        multiple={directory}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // The same choice again must still upload, so forget this one.
          event.currentTarget.value = "";
          const [first] = files;
          if (first === undefined) {
            return;
          }
          if (directory) {
            // Each path starts with the chosen folder: `Shop.app/Info.plist`.
            const [folder = first.name] = first.webkitRelativePath.split("/");
            onFiles(
              files.map((file) => ({ file, path: file.webkitRelativePath })),
              folder
            );
          } else {
            onFiles([{ file: first, path: first.name }], first.name);
          }
        }}
        ref={input}
        tabIndex={-1}
        type="file"
        {...(directory ? { webkitdirectory: "" } : {})}
      />
      <Button
        aria-describedby={describedBy}
        disabled={disabled || uploading}
        onClick={() => input.current?.click()}
        size="sm"
        type="button"
        variant="outline"
      >
        {uploading ? (
          <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
        ) : (
          <UploadIcon aria-hidden="true" />
        )}
        {label}
      </Button>
      <p
        aria-live="polite"
        className={cn(
          "text-xs text-pretty",
          state._tag === "failed" ? "text-destructive" : "text-muted-foreground"
        )}
        id={describedBy}
      >
        {state._tag === "uploading" ? `Reading ${state.name}…` : null}
        {state._tag === "failed" ? state.message : null}
        {state._tag === "idle"
          ? "Installing it asks for your consent first."
          : null}
      </p>
    </div>
  );
};

/** The uploaded build that will become the Target App, with a way back. */
export const UploadedBuild = ({
  detail,
  name,
  onRemove,
  title,
}: {
  readonly detail: string;
  readonly name: string;
  readonly onRemove: () => void;
  readonly title: string;
}) => (
  <div className="flex min-w-0 items-center gap-2.5 rounded-lg border p-2.5">
    <PackageIcon aria-hidden="true" className="size-4 shrink-0" />
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{title}</p>
      <p className="text-muted-foreground truncate text-xs" title={name}>
        {detail}
      </p>
    </div>
    <Button
      aria-label={`Remove ${name}`}
      onClick={onRemove}
      size="icon-xs"
      title="Remove"
      type="button"
      variant="ghost"
    >
      <XIcon />
    </Button>
  </div>
);
