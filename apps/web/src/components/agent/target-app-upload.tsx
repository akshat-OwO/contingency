import { useAtom } from "@effect/atom-react";
import { Effect, Fiber } from "effect";
import { Atom } from "effect/reactivity";
import { LoaderCircleIcon, PackageIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  FileInput,
  FileInputDropzone,
  FileInputTrigger,
  relativePath,
} from "@/components/ui/file-input";
import { Skeleton } from "@/components/ui/skeleton";
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

/** What the upload is doing, said under its picker and read with it. */
const BuildUploadStatus = ({
  id,
  state,
}: {
  readonly id: string;
  readonly state: BuildUploadState;
}) => (
  <p
    aria-live="polite"
    className={cn(
      "text-xs text-pretty",
      state._tag === "failed" ? "text-destructive" : "text-muted-foreground"
    )}
    id={id}
  >
    {state._tag === "uploading" ? `Reading ${state.name}…` : null}
    {state._tag === "failed" ? state.message : null}
    {state._tag === "idle"
      ? "Installing it asks for your consent first."
      : null}
  </p>
);

const FolderPickerRow = ({ children }: { readonly children: ReactNode }) => (
  <div className="border-island-border flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-xl border border-dashed px-3 py-3 text-[13px]">
    {children}
  </div>
);

/** A chosen file and its path, as an iOS `.app` upload sends it. */
export interface ChosenFile extends AppBundleFile {
  readonly file: File;
}

/**
 * A drop zone for one build file, such as an Android `.apk`, with the button
 * that opens the file picker inside it. With `directory` it picks a whole
 * folder, such as an iOS simulator `.app`, through the picker only. Each choice uploads at once; the zone keeps
 * no file of its own, so choosing the same build again uploads it again.
 */
export const BuildDropzone = ({
  accept,
  describedBy,
  directory = false,
  kind,
  label,
  onFiles,
  state,
}: {
  readonly accept?: string;
  readonly describedBy: string;
  /** Picks and accepts a folder, every file inside it, rather than one file. */
  readonly directory?: boolean;
  /** The build's kind, as the zone names it: `.apk` or `.app`. */
  readonly kind: string;
  readonly label: string;
  /**
   * The chosen build: one file, or a folder's files with paths that start at
   * the folder, `Shop.app/Info.plist`, and the folder's name.
   */
  readonly onFiles: (files: readonly ChosenFile[], name: string) => void;
  readonly state: BuildUploadState;
}) => {
  const uploading = state._tag === "uploading";
  // UI SDK reads a dropped folder only up to 1,000 files, which would upload
  // part of a bundle, so a folder comes through the picker alone (#752).
  const Zone = directory ? FolderPickerRow : FileInputDropzone;
  return (
    <div className="grid gap-1.5">
      <FileInput
        {...(accept === undefined ? {} : { accept })}
        directory={directory}
        disabled={uploading}
        onValueChange={(files) => {
          const [first] = files;
          if (first === undefined) {
            return;
          }
          if (!directory) {
            onFiles([{ file: first, path: first.name }], first.name);
            return;
          }
          const entries = files.map((file) => ({
            file,
            path: relativePath(file),
          }));
          const [folder = first.name] = (entries[0]?.path ?? "").split("/");
          onFiles(entries, folder);
        }}
        value={[]}
      >
        <Zone>
          {uploading ? (
            <LoaderCircleIcon
              aria-hidden="true"
              className="text-muted-foreground size-4 animate-spin"
            />
          ) : (
            <UploadIcon
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
          )}
          <span className="text-muted-foreground">
            {directory ? "Choose the " : "Drop an "}
            <span className="font-mono">{kind}</span>
            {directory ? " folder:" : " here, or"}
          </span>
          <FileInputTrigger
            aria-describedby={describedBy}
            className={buttonVariants({ size: "xs", variant: "outline" })}
          >
            {label}
          </FileInputTrigger>
        </Zone>
      </FileInput>
      <BuildUploadStatus id={describedBy} state={state} />
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

export type InstalledAppsNotice =
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "message";
      readonly text: string;
      readonly tone: "muted" | "destructive";
    };

/**
 * The apps on a device, in a frame whose height never changes. Loading,
 * failure and empty notices render inside it, so the steps below stay in
 * place when the read finishes.
 */
/** Name and badge widths that vary like a real app list. */
const skeletonRows = [
  { badge: "w-14", name: "w-2/5" },
  { badge: "w-12", name: "w-1/2" },
  { badge: "w-14", name: "w-1/3" },
  { badge: "w-12", name: "w-3/5" },
  { badge: "w-14", name: "w-2/5" },
] as const;

export const InstalledAppsFrame = ({
  children,
  notice,
}: {
  readonly children?: ReactNode;
  readonly notice: InstalledAppsNotice | null;
}) => (
  <div className="h-44 overflow-y-auto rounded-lg border">
    {notice?._tag === "loading" ? (
      <>
        <p className="sr-only" role="status">
          Reading installed apps…
        </p>
        <div aria-hidden="true" className="py-0.5">
          {skeletonRows.map((row, index) => (
            <div
              className="flex items-center justify-between gap-2 px-2.5 py-2"
              // The rows are fixed placeholders; their order never changes.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
            >
              <Skeleton
                className={cn("h-4 motion-reduce:animate-none", row.name)}
              />
              <Skeleton
                className={cn(
                  "h-5 rounded-full motion-reduce:animate-none",
                  row.badge
                )}
              />
            </div>
          ))}
        </div>
      </>
    ) : null}
    {notice?._tag === "message" ? (
      <p
        className={cn(
          "flex h-full items-center justify-center px-4 text-center text-xs",
          notice.tone === "destructive"
            ? "text-destructive"
            : "text-muted-foreground"
        )}
      >
        {notice.text}
      </p>
    ) : null}
    {notice === null ? <ul aria-label="Installed apps">{children}</ul> : null}
  </div>
);
