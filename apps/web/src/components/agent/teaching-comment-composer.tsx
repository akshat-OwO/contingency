import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { openTeachingTimespan } from "@contingency/protocol";
import type {
  TeachingScan,
  TeachingBrowserAttachment,
  ScanMode,
  TeachingInstruction,
} from "@contingency/protocol";
import {
  AccessibilityIcon,
  GaugeIcon,
  SquareIcon,
  AppWindowIcon,
  CornerDownLeftIcon,
  CrosshairIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  XIcon,
} from "lucide-react";
import { useRef } from "react";

import type {
  CommentShortcut,
  ShortcutPlatform,
} from "@/components/agent/teaching-comment-shortcuts";
import { shortcutKeys } from "@/components/agent/teaching-comment-shortcuts";
import type { InspectState } from "@/components/agent/teaching-inspect-state";
import { elapsedLabel } from "@/components/agent/teaching-recording-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  attachmentMime,
  readAttachment,
  storageAttachment,
} from "./browser-check-attachments";
import { BrowserAttachmentEditor } from "./browser-check-authoring";

const scanLabels: Record<ScanMode, string> = {
  accessibility: "Accessibility scan",
  navigation: "Measure the next navigation",
  reload: "Reload at this point",
  timespan: "Interaction timespan",
};

/** A shortcut's keys, one `Kbd` each, so `⌘ ⇧ K` reads as three keys. */
export const ShortcutKbd = ({
  className,
  platform,
  scope,
  shortcut,
}: {
  readonly className?: string | undefined;
  readonly platform: ShortcutPlatform;
  readonly scope: "bare" | "chord";
  readonly shortcut: CommentShortcut;
}) => (
  <KbdGroup aria-hidden="true" className={className}>
    {shortcutKeys(shortcut, scope, platform).map((key) => (
      <Kbd key={key}>{key}</Kbd>
    ))}
  </KbdGroup>
);

const CommentTarget = ({ target }: { readonly target: string | null }) =>
  target === null ? (
    <span className="inline-flex items-center gap-1">
      <AppWindowIcon aria-hidden="true" className="size-3" />
      Page
    </span>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1 text-blue-600 dark:text-blue-400">
      <CrosshairIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{target}</span>
    </span>
  );

/**
 * The comments this recording has collected, newest first. An instruction is
 * a recorded event, so the list is read-only. Pointing at one whose pin is on
 * this Page outlines its element behind the composer.
 */
const CommentHistory = ({
  onEdit,
  instructions,
  onHighlight,
  pinned,
  startedAt,
}: {
  readonly onEdit: (instruction: TeachingInstruction) => void;
  readonly instructions: readonly TeachingInstruction[];
  readonly onHighlight: (index?: number) => void;
  readonly pinned: ReadonlySet<number>;
  readonly startedAt: string;
}) => {
  if (instructions.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-sm">
        No comments yet. Type one, or attach an element first.
      </p>
    );
  }
  return (
    <ul
      aria-label="Earlier comments"
      className="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain"
    >
      {instructions
        .map((instruction, position) => ({ index: position + 1, instruction }))
        .toReversed()
        .map(({ index, instruction }) => {
          const hasPin = pinned.has(index);
          return (
            <li
              className="hover:bg-muted flex gap-3 rounded-lg px-2.5 py-2 transition-colors"
              key={instruction.id}
              onPointerEnter={hasPin ? () => onHighlight(index) : undefined}
              onPointerLeave={hasPin ? () => onHighlight() : undefined}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums",
                  hasPin
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {instruction.target === null ? (
                  <MessageCircleIcon className="size-3" />
                ) : (
                  index
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm leading-snug text-pretty wrap-anywhere">
                  {instruction.text}
                  {instruction.scan === undefined ? null : (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {instruction.scan.phase === "stop"
                        ? "End interaction timespan"
                        : scanLabels[instruction.scan.mode]}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 font-mono tabular-nums">
                    {elapsedLabel(startedAt, Date.parse(instruction.at))}
                  </span>
                  <CommentTarget target={instruction.target} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(instruction)}
                  >
                    Edit comment
                  </Button>
                </span>
              </span>
            </li>
          );
        })}
    </ul>
  );
};

const ScanButtons = ({
  open,
  onOpenChange,
  openTimespan,
  pending,
  selectScan,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly openTimespan: TeachingScan | undefined;
  readonly pending: boolean;
  readonly selectScan: (mode: ScanMode, stop?: boolean) => void;
}) => (
  <>
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            aria-label="Performance scan"
            title="Performance scan"
            disabled={pending}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <GaugeIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" positionerClassName="z-[60]">
        <PopoverTitle>Teach a scan for later Runs</PopoverTitle>
        {openTimespan === undefined ? (
          (["reload", "navigation", "timespan"] as const).map((mode) => (
            <Button
              className="justify-start"
              key={mode}
              onClick={() => selectScan(mode)}
              variant="ghost"
            >
              {scanLabels[mode]}
            </Button>
          ))
        ) : (
          <Button
            className="justify-start"
            onClick={() => selectScan("timespan", true)}
            variant="ghost"
          >
            <SquareIcon />
            End timespan
          </Button>
        )}
        <Button
          className="justify-start"
          disabled={openTimespan !== undefined}
          onClick={() => selectScan("accessibility")}
          variant="ghost"
        >
          <AccessibilityIcon />
          Accessibility scan
        </Button>
        <p className="text-muted-foreground px-2 text-xs">
          The agent will propose when to scan for your review. Reload may
          discard transient page state.
        </p>
      </PopoverContent>
    </Popover>
    <Button
      aria-label="Accessibility scan"
      title="Accessibility scan"
      disabled={pending || openTimespan !== undefined}
      onClick={() => selectScan("accessibility")}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <AccessibilityIcon aria-hidden="true" />
    </Button>
  </>
);

/**
 * The comment composer: a command-palette dialog over the browser. A comment
 * is written here whether or not it names an element. Without one it is a
 * page comment; with one, inspect has attached the element as a chip.
 *
 * The composer stays open while DevTools is used and closes on Escape or submission.
 */
const CommentAttachments = ({
  state,
  pending,
  origin,
  onAttach,
  onAttachmentsChange,
}: {
  readonly state: InspectState;
  readonly pending: boolean;
  readonly origin: string;
  readonly onAttach: (attachment: TeachingBrowserAttachment) => void;
  readonly onAttachmentsChange: (
    attachments: readonly TeachingBrowserAttachment[]
  ) => void;
}) => (
  <fieldset disabled={pending} className="grid gap-2">
    {" "}
    {(state.attachments ?? []).map((attachment) => (
      <BrowserAttachmentEditor
        key={attachment.id}
        attachment={attachment}
        onChange={(updated) =>
          onAttachmentsChange(
            (state.attachments ?? []).map((existing) =>
              existing.id === attachment.id ? updated : existing
            )
          )
        }
        onRemove={() =>
          onAttachmentsChange(
            (state.attachments ?? []).filter(
              (existing) => existing.id !== attachment.id
            )
          )
        }
      />
    ))}
    <p className="text-muted-foreground text-xs">
      Drag a request or cookie from DevTools here. A response field starts a
      check.
    </p>
    <Button
      disabled={pending || (state.attachments?.length ?? 0) >= 50}
      type="button"
      variant="ghost"
      onClick={() => {
        const context = storageAttachment(origin, "cookie-name", "cookie");
        onAttach({ ...context, requirement: context.candidate });
      }}
    >
      Require an unseen cookie
    </Button>
  </fieldset>
);

export const CommentComposer = ({
  onEdit,
  origin,
  onAttachmentsChange,
  onAttach,
  instructions,
  onDetach,
  onDraftChange,
  onHighlight,
  onOpenChange,
  onPick,
  onSubmit,
  onScanChange,
  onScanMenuChange,
  pending,
  platform,
  startedAt,
  state,
}: {
  readonly origin: string;
  readonly onAttachmentsChange: (
    attachments: readonly TeachingBrowserAttachment[]
  ) => void;
  readonly onAttach: (attachment: TeachingBrowserAttachment) => void;
  readonly onEdit: (instruction: TeachingInstruction) => void;
  /** Every instruction on this recording, oldest first. */
  readonly instructions: readonly TeachingInstruction[];
  readonly onDetach: () => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onHighlight: (index?: number) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: () => void;
  readonly onSubmit: () => void;
  readonly onScanChange: (scan?: TeachingScan) => void;
  readonly onScanMenuChange: (open: boolean) => void;
  /** A save is in flight, so the composer is read-only until it answers. */
  readonly pending: boolean;
  readonly platform: ShortcutPlatform;
  readonly startedAt: string;
  readonly state: InspectState;
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  const attached = state.frozen;
  const openTimespan = openTeachingTimespan(instructions);
  const selectScan = (mode: ScanMode, stop = false) => {
    onScanChange({
      id:
        stop && openTimespan !== undefined
          ? openTimespan.id
          : globalThis.crypto.randomUUID(),
      mode,
      phase: stop ? "stop" : "start",
    });
    if (
      state.draft.trim() === "" ||
      /^@(?:performance|a11y)$/u.test(state.draft.trim())
    ) {
      onDraftChange(
        stop
          ? "Stop the timespan performance scan here."
          : `Run ${scanLabels[mode].toLowerCase()} here.`
      );
    }
    field.current?.focus();
  };
  const popup = useRef<HTMLDivElement>(null);
  const submit = () => {
    const inputs = popup.current?.querySelectorAll<HTMLInputElement>(
      "input, textarea, select"
    );
    for (const input of inputs ?? []) {
      if (!input.reportValidity()) {
        return;
      }
    }
    onSubmit();
  };
  const canSubmit = !pending && state.draft.trim() !== "";
  const pinned = new Set(state.comments.map((comment) => comment.index));
  return (
    <Dialog
      disablePointerDismissal
      modal={false}
      onOpenChange={onOpenChange}
      open={state.composing}
    >
      <DialogPortal>
        {/*
          No backdrop blur: the outline of a comment's element has to stay
          legible behind the composer while its list item is pointed at.
        */}
        <DialogPrimitive.Popup
          onDragOver={(event) => {
            if (!pending && event.dataTransfer.types.includes(attachmentMime)) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            if (pending) {
              return;
            }
            const attachment = readAttachment(event);
            if (attachment !== undefined) {
              event.preventDefault();
              onAttach(attachment);
            }
          }}
          className="bg-popover text-popover-foreground ring-foreground/10 fixed bottom-28 left-4 z-50 flex max-h-[65svh] w-[min(30rem,calc(100%-2rem))] flex-col overflow-auto rounded-2xl text-sm shadow-2xl ring-1 outline-none"
          initialFocus={field}
          ref={popup}
        >
          <DialogTitle className="sr-only">Comment</DialogTitle>
          <DialogDescription className="sr-only">
            Tell the agent something about this moment of the recording.
          </DialogDescription>
          <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
            <CommentAttachments
              state={state}
              pending={pending}
              origin={origin}
              onAttach={onAttach}
              onAttachmentsChange={onAttachmentsChange}
            />
            {state.scan === undefined ? null : (
              <span className="bg-muted inline-flex items-center gap-1 self-start rounded-md py-0.5 pr-0.5 pl-2 text-xs">
                {state.scan.phase === "stop"
                  ? "End interaction timespan"
                  : scanLabels[state.scan.mode]}
                <Button
                  aria-label="Remove scan"
                  disabled={pending}
                  onClick={() => onScanChange()}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </span>
            )}
            {openTimespan === undefined ? null : (
              <p className="text-muted-foreground text-xs">
                Open timespan · collection happens in later Runs
              </p>
            )}
            {attached === undefined ? null : (
              <span className="inline-flex max-w-full items-center gap-1 self-start rounded-md bg-blue-500/10 py-0.5 pr-0.5 pl-1.5 text-sm font-medium text-blue-600 dark:text-blue-400">
                <CrosshairIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{attached.description}</span>
                <Button
                  aria-label="Remove attached element"
                  className="hover:bg-blue-500/15"
                  disabled={pending}
                  onClick={onDetach}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </span>
            )}
            <textarea
              aria-label="Comment"
              className="placeholder:text-muted-foreground field-sizing-content max-h-48 min-h-14 w-full resize-none bg-transparent text-base leading-7 outline-none"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSubmit) {
                    submit();
                  }
                } else if (
                  event.key === "Backspace" &&
                  state.draft === "" &&
                  attached !== undefined
                ) {
                  event.preventDefault();
                  onDetach();
                }
              }}
              placeholder={
                attached === undefined
                  ? "What should the agent know about this moment?"
                  : "What should change here?"
              }
              readOnly={pending}
              ref={field}
              rows={1}
              value={state.draft}
            />
          </div>
          <div className="flex items-center gap-2 px-3 pb-3">
            <Button
              disabled={pending}
              onClick={onPick}
              size="sm"
              type="button"
              variant="ghost"
            >
              <MousePointerClickIcon aria-hidden="true" />
              {attached === undefined ? "Attach element" : "Change element"}
              <ShortcutKbd
                className="hidden sm:inline-flex"
                platform={platform}
                scope="chord"
                shortcut="inspect"
              />
            </Button>
            <ScanButtons
              open={state.scanMenu ?? false}
              onOpenChange={onScanMenuChange}
              openTimespan={openTimespan}
              pending={pending}
              selectScan={selectScan}
            />
            <span className="flex-1" />
            {state.error === undefined ? null : (
              <p
                className="text-destructive min-w-0 truncate text-xs"
                role="alert"
              >
                {state.error}
              </p>
            )}
            <Button
              disabled={!canSubmit}
              onClick={submit}
              size="sm"
              type="button"
            >
              {state.editingInstructionId === undefined
                ? "Add comment"
                : "Save comment"}
              <Kbd className="bg-primary-foreground/15 text-primary-foreground">
                <CornerDownLeftIcon aria-hidden="true" />
              </Kbd>
            </Button>
          </div>
          <section
            aria-label="Earlier in this recording"
            className="flex min-h-0 flex-col border-t"
          >
            <h2 className="text-muted-foreground px-4 pt-3 pb-1 text-xs font-medium">
              Earlier in this recording
            </h2>
            <div className="min-h-0 px-1.5 pb-1.5">
              <CommentHistory
                onEdit={onEdit}
                instructions={instructions}
                onHighlight={onHighlight}
                pinned={pinned}
                startedAt={startedAt}
              />
            </div>
          </section>
          <footer className="text-muted-foreground bg-muted/40 flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeftIcon aria-hidden="true" />
              </Kbd>
              add
            </span>
            <span className="inline-flex items-center gap-1.5">
              <KbdGroup>
                <Kbd>{platform === "mac" ? "⇧" : "Shift"}</Kbd>
                <Kbd>
                  <CornerDownLeftIcon aria-hidden="true" />
                </Kbd>
              </KbdGroup>
              new line
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ShortcutKbd
                className="hidden sm:inline-flex"
                platform={platform}
                scope="chord"
                shortcut="inspect"
              />
              attach element
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>Esc</Kbd>
              close
            </span>
          </footer>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
};
