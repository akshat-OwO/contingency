import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { TeachingInstruction } from "@contingency/protocol";
import {
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
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

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
  instructions,
  onHighlight,
  pinned,
  startedAt,
}: {
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
                </span>
                <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 font-mono tabular-nums">
                    {elapsedLabel(startedAt, Date.parse(instruction.at))}
                  </span>
                  <CommentTarget target={instruction.target} />
                </span>
              </span>
            </li>
          );
        })}
    </ul>
  );
};

/**
 * The comment composer: a command-palette dialog over the browser. A comment
 * is written here whether or not it names an element. Without one it is a
 * page comment; with one, inspect has attached the element as a chip.
 *
 * It is a modal dialog, so it traps focus, closes on `Escape` and on a click
 * outside, and gives focus back to whatever held it — usually the browser the
 * user was driving.
 */
export const CommentComposer = ({
  instructions,
  onDetach,
  onDraftChange,
  onHighlight,
  onOpenChange,
  onPick,
  onSubmit,
  pending,
  platform,
  startedAt,
  state,
}: {
  /** Every instruction on this recording, oldest first. */
  readonly instructions: readonly TeachingInstruction[];
  readonly onDetach: () => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onHighlight: (index?: number) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: () => void;
  readonly onSubmit: () => void;
  /** A save is in flight, so the composer is read-only until it answers. */
  readonly pending: boolean;
  readonly platform: ShortcutPlatform;
  readonly startedAt: string;
  readonly state: InspectState;
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  const attached = state.frozen;
  const canSubmit = !pending && state.draft.trim() !== "";
  const pinned = new Set(state.comments.map((comment) => comment.index));
  return (
    <Dialog onOpenChange={onOpenChange} open={state.composing}>
      <DialogPortal>
        {/*
          No backdrop blur: the outline of a comment's element has to stay
          legible behind the composer while its list item is pointed at.
        */}
        <DialogOverlay className="bg-black/15 supports-backdrop-filter:backdrop-blur-none dark:bg-black/40" />
        <DialogPrimitive.Popup
          className="bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-2 data-closed:animate-out data-closed:fade-out-0 fixed top-[12%] left-1/2 z-50 flex max-h-[76svh] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-sm shadow-2xl ring-1 outline-none"
          initialFocus={field}
        >
          <DialogTitle className="sr-only">Comment</DialogTitle>
          <DialogDescription className="sr-only">
            Tell the agent something about this moment of the recording.
          </DialogDescription>
          <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
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
                    onSubmit();
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
                platform={platform}
                scope="chord"
                shortcut="inspect"
              />
            </Button>
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
              onClick={onSubmit}
              size="sm"
              type="button"
            >
              Add comment
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
