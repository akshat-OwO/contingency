import {
  CornerDownLeftIcon,
  MessageCircleIcon,
  MousePointer2Icon,
  XIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { elapsedLabel } from "@/components/agent/teaching-recording-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const TICK_MS = 1000;
/** The gap between the Session status island and the card above it. */
const ANCHOR_GAP = 12;
const EDGE = 16;

/** How long the recording has run, as the card's header reads it. */
const useElapsed = (startedAt: string | undefined) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) {
      return;
    }
    setNow(Date.now());
    const interval = globalThis.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => globalThis.clearInterval(interval);
  }, [startedAt]);
  return startedAt === undefined ? undefined : elapsedLabel(startedAt, now);
};

const fallbackAnchor: CSSProperties = { bottom: 88, right: EDGE };

/**
 * Where the card sits: above the Session status island it opens from, with
 * their right edges aligned. The island moves with the stage, DevTools and
 * the window, so the card follows its box rather than a fixed corner.
 */
const useStatusIslandAnchor = (open: boolean): CSSProperties => {
  const [anchor, setAnchor] = useState<CSSProperties>(fallbackAnchor);
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const island = document.querySelector<HTMLElement>(
      '[data-slot="workspace-dock"]'
    );
    if (island === null) {
      setAnchor(fallbackAnchor);
      return;
    }
    const measure = () => {
      const box = island.getBoundingClientRect();
      const bottom = Math.max(
        EDGE,
        Math.round(window.innerHeight - box.top + ANCHOR_GAP)
      );
      setAnchor({
        bottom,
        maxHeight: `calc(100svh - ${bottom + EDGE}px)`,
        right: Math.max(EDGE, Math.round(window.innerWidth - box.right)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(island);
    // The stage narrows when DevTools docks, moving the island without
    // resizing it; the dock container spans the stage, so it resizes then.
    const container = island.closest('[data-slot="workspace-dock-container"]');
    if (container !== null) {
      observer.observe(container);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  return anchor;
};

/** Something attached to the comment: an element or a scan. */
export const CommentChip = ({
  children,
  disabled,
  icon,
  onRemove,
  removeLabel,
  tone,
}: {
  readonly children: ReactNode;
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly onRemove: () => void;
  readonly removeLabel: string;
  readonly tone: "element" | "scan";
}) => (
  <span
    className={cn(
      "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-[10px] pr-[3px] pl-2 text-xs font-medium [&>svg]:size-3.5 [&>svg]:shrink-0",
      tone === "element"
        ? "bg-status-running/12 text-status-running"
        : "bg-status-ready/13 text-foreground [&>svg]:text-status-ready"
    )}
    data-slot="comment-chip"
  >
    {icon}
    <span className="flex min-w-0 items-center gap-1.5 *:min-w-0 *:truncate">
      {children}
    </span>
    <Button
      aria-label={removeLabel}
      className="size-[22px] rounded-[7px] hover:bg-black/5 dark:hover:bg-white/10"
      disabled={disabled}
      onClick={onRemove}
      size="icon-xs"
      type="button"
      variant="ghost"
    >
      <XIcon />
    </Button>
  </span>
);

/** One comment already on the recording, as the earlier list shows it. */
export interface EarlierComment {
  readonly id: string;
  /** Its number on the recording, counting from 1. */
  readonly index: number;
  readonly text: string;
  /** The recording time it was taken at. */
  readonly time: string;
  /** The element it names, or undefined for a comment on the whole Page or screen. */
  readonly target: string | undefined;
  /** Facts beside the target, such as the scan it asked for. */
  readonly details?: readonly string[];
  /** Whether its pin is on the current Page or screen. */
  readonly pinned: boolean;
}

/**
 * The comments this recording has collected, newest first. Pointing at one
 * whose pin is on the current Page or screen outlines its element.
 */
const EarlierComments = ({
  comments,
  editingId,
  onEdit,
  onHighlight,
}: {
  readonly comments: readonly EarlierComment[];
  readonly editingId: string | undefined;
  readonly onEdit: ((id: string) => void) | undefined;
  readonly onHighlight: (index?: number) => void;
}) => (
  <section
    aria-label="Earlier in this recording"
    className="border-island-border flex min-h-0 flex-col border-t"
  >
    <h3 className="text-muted-foreground/80 flex items-center gap-2 px-4 pt-2.5 pb-1 text-xs font-semibold tracking-[0.04em] uppercase">
      Earlier in this recording
      <span className="font-mono tracking-normal tabular-nums">
        {comments.length}
      </span>
    </h3>
    {comments.length === 0 ? (
      <p className="text-muted-foreground mx-4 mt-1 mb-3.5 text-xs">
        No comments yet. Type one, or attach an element first.
      </p>
    ) : (
      <ul
        aria-label="Earlier comments"
        className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-px overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {comments.toReversed().map((comment) => (
          <li
            className={cn(
              "group/earlier hover:bg-island-hover grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-xl py-2 pr-1.5 pl-2.5 transition-colors",
              editingId === comment.id && "bg-island-hover"
            )}
            key={comment.id}
            onPointerEnter={
              comment.pinned ? () => onHighlight(comment.index) : undefined
            }
            onPointerLeave={comment.pinned ? () => onHighlight() : undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-px grid size-[22px] place-items-center rounded-full font-mono text-xs font-semibold tabular-nums",
                comment.pinned
                  ? "bg-status-running text-white"
                  : "bg-island-hover text-muted-foreground"
              )}
            >
              {comment.target === undefined ? (
                <MessageCircleIcon className="size-3" />
              ) : (
                comment.index
              )}
            </span>
            <span className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[3px] text-[13px] leading-[1.45] text-pretty wrap-anywhere">
              {comment.text}
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                <span className="font-mono text-xs tabular-nums">
                  {comment.time}
                </span>
                {comment.target === undefined ? (
                  <span>Page</span>
                ) : (
                  <span className="text-status-running inline-flex max-w-full min-w-0 items-center gap-1">
                    <MousePointer2Icon
                      aria-hidden="true"
                      className="size-[11px] shrink-0"
                    />
                    <span className="truncate">{comment.target}</span>
                  </span>
                )}
                {comment.details?.map((detail) => (
                  <span key={detail}>{detail}</span>
                ))}
              </span>
            </span>
            {onEdit === undefined ? (
              <span />
            ) : (
              <Button
                aria-label={`Edit comment ${comment.index}`}
                className="opacity-0 group-hover/earlier:opacity-100 focus-visible:opacity-100"
                onClick={() => onEdit(comment.id)}
                size="xs"
                type="button"
                variant="island"
              >
                Edit
              </Button>
            )}
          </li>
        ))}
      </ul>
    )}
  </section>
);

/**
 * The Teaching comment card, on Web and native. It sits above the Session
 * status island it opens from and stays open while the user works the page,
 * DevTools or the device. Escape cancels a pick first, then closes an open
 * side card, then the comment. An outside press never closes it: Attach
 * element needs that press to reach the stage.
 */
export const CommentCard = ({
  aside,
  attach,
  canSubmit,
  chips,
  draft,
  earlier,
  editingId,
  error,
  fieldRef,
  note,
  onBackspaceEmpty,
  onCloseAside,
  onDraftChange,
  onDragOver,
  onDrop,
  onEdit,
  onHighlight,
  onOpenChange,
  onSubmit,
  open,
  pending,
  placeholder,
  popupRef,
  startedAt,
  tools,
}: {
  /** A side card, such as a check's editor, beside the comment card. */
  readonly aside?: ReactNode;
  readonly attach: {
    readonly attached: boolean;
    readonly disabled: boolean;
    readonly onCancel: () => void;
    readonly onPick: () => void;
    readonly picking: boolean;
    /** The keys that start a pick, as the button's title reads them. */
    readonly shortcut?: string;
  };
  readonly canSubmit: boolean;
  readonly chips?: ReactNode;
  readonly draft: string;
  readonly earlier: readonly EarlierComment[];
  readonly editingId: string | undefined;
  readonly error: string | undefined;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly note?: ReactNode;
  readonly onBackspaceEmpty?: (() => void) | undefined;
  readonly onCloseAside?: (() => void) | undefined;
  readonly onDraftChange: (draft: string) => void;
  readonly onDragOver?: React.DragEventHandler<HTMLDivElement>;
  readonly onDrop?: React.DragEventHandler<HTMLDivElement>;
  readonly onEdit?: ((id: string) => void) | undefined;
  readonly onHighlight: (index?: number) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: () => void;
  readonly open: boolean;
  /** A save is in flight, so the card is read-only until it answers. */
  readonly pending: boolean;
  readonly placeholder: string;
  readonly popupRef?: RefObject<HTMLDivElement | null>;
  readonly startedAt: string | undefined;
  /** Platform tools after Attach element, such as scans. */
  readonly tools?: ReactNode;
}) => {
  const anchor = useStatusIslandAnchor(open);
  const elapsed = useElapsed(open ? startedAt : undefined);
  const { picking } = attach;
  return (
    <Dialog
      closeOnOutsidePress={false}
      modal={false}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key") {
          if (picking) {
            details.cancel();
            attach.onCancel();
            return;
          }
          if (aside !== undefined && aside !== null && onCloseAside) {
            details.cancel();
            onCloseAside();
            fieldRef.current?.focus();
            return;
          }
        }
        onOpenChange(next);
      }}
      open={open}
    >
      {/*
          The popup only places the card and its side card. No backdrop: the
          outline of a comment's element stays legible behind the card.
        */}
      <DialogPopup
        className="fixed top-auto left-auto z-50 m-0 flex w-[min(440px,calc(100vw-2rem))] max-w-none flex-col overflow-visible border-0 bg-transparent p-0 text-sm outline-none"
        initialFocus={() => fieldRef.current}
        onDragOver={onDragOver}
        onDrop={onDrop}
        ref={popupRef}
        style={anchor}
      >
        <div
          className="island bg-island-solid shadow-island-lift animate-in fade-in-0 zoom-in-95 flex min-h-0 flex-1 origin-bottom-right flex-col overflow-clip rounded-[18px] duration-200 motion-reduce:animate-none"
          data-picking={picking || undefined}
          data-slot="comment-card"
        >
          <header className="flex items-center gap-1.5 pt-2.5 pr-2 pl-4">
            {/*
              The dialog is named "Comment" in every mode, so it is found the
              same way while editing; the visible heading adds the mode and
              the recording time.
            */}
            <DialogTitle className="sr-only">Comment</DialogTitle>
            <p aria-hidden="true" className="flex-1 text-sm font-semibold">
              {editingId === undefined ? "Comment" : "Edit comment"}
              {elapsed === undefined ? null : (
                <span className="text-muted-foreground ml-1 font-mono text-xs font-medium tabular-nums">
                  at {elapsed}
                </span>
              )}
            </p>
            <DialogDescription className="sr-only">
              Tell the agent something about this moment of the recording.
            </DialogDescription>
            <Button
              aria-label="Close comment"
              onClick={() => onOpenChange(false)}
              size="icon-sm"
              title="Close comment"
              type="button"
              variant="island"
            >
              <XIcon />
            </Button>
          </header>
          <div
            className={cn(
              "grid grid-cols-[minmax(0,1fr)] gap-2 px-4 pt-1.5 pb-1 transition-opacity",
              picking && "opacity-50"
            )}
          >
            <div className="flex flex-wrap gap-1.5 empty:hidden">{chips}</div>
            <textarea
              aria-label="Comment"
              className="placeholder:text-muted-foreground/70 field-sizing-content max-h-45 min-h-13 w-full resize-none bg-transparent py-1 text-[15px] leading-normal outline-none"
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
                  draft === "" &&
                  onBackspaceEmpty !== undefined
                ) {
                  event.preventDefault();
                  onBackspaceEmpty();
                }
              }}
              placeholder={placeholder}
              readOnly={pending}
              ref={fieldRef}
              rows={2}
              value={draft}
            />
            {note}
            {error === undefined ? null : (
              <p
                className="bg-status-recording/12 text-status-recording rounded-[10px] px-2.5 py-[7px] text-[12.5px]"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-0.5 px-2.5 pt-1 pb-2.5">
            <Button
              aria-pressed={picking}
              className="aria-pressed:bg-status-running/14 aria-pressed:text-status-running"
              disabled={attach.disabled}
              onClick={picking ? attach.onCancel : attach.onPick}
              title={
                attach.shortcut === undefined
                  ? undefined
                  : `${attach.attached ? "Change element" : "Attach element"} (${attach.shortcut})`
              }
              size="island"
              type="button"
              variant="island"
            >
              <MousePointer2Icon aria-hidden="true" />
              {attach.attached ? "Change element" : "Attach element"}
            </Button>
            {tools}
            <span className="flex-1" />
            <Button
              className="h-[34px] shrink-0 rounded-[11px] pr-2 pl-3.5"
              disabled={!canSubmit}
              onClick={onSubmit}
              type="button"
            >
              {editingId === undefined ? "Add comment" : "Save comment"}
              <Kbd
                aria-hidden="true"
                className="bg-primary-foreground/18 text-primary-foreground"
              >
                <CornerDownLeftIcon />
              </Kbd>
            </Button>
          </div>
          <div
            className={cn(
              "flex min-h-0 flex-col transition-opacity",
              picking && "opacity-50"
            )}
          >
            <EarlierComments
              comments={earlier}
              editingId={editingId}
              onEdit={onEdit}
              onHighlight={onHighlight}
            />
          </div>
        </div>
        {aside === undefined || aside === null ? null : (
          <div
            className="absolute right-[calc(100%+12px)] bottom-0 flex max-w-[calc(100vw-2rem)] flex-col"
            style={{ maxHeight: anchor.maxHeight }}
          >
            {aside}
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
};

/** How far around the hint the pointer counts as under it. */
const HINT_PAD = 12;

/**
 * The hint at the top of the stage while Attach element picks. It reads like
 * a notice and turns into the error when a pick misses. It takes no input:
 * the pointer picks whatever is under it, and the hint fades while the
 * pointer is there. Escape, or Attach element again, cancels.
 */
export const InspectHint = ({
  error,
  verb,
}: {
  readonly error: string | undefined;
  readonly verb: "Click" | "Tap";
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [under, setUnder] = useState(false);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      if (box === undefined) {
        return;
      }
      setUnder(
        event.clientX > box.left - HINT_PAD &&
          event.clientX < box.right + HINT_PAD &&
          event.clientY > box.top - HINT_PAD &&
          event.clientY < box.bottom + HINT_PAD
      );
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return (
    <div
      className={cn(
        "island bg-island-solid pointer-events-none absolute top-3 left-1/2 z-10 flex h-10 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full pr-2.5 pl-3.5 text-sm transition-opacity duration-150",
        under && "opacity-[0.12]",
        error === undefined ? null : "text-status-recording"
      )}
      data-slot="inspect-hint"
      ref={ref}
      role={error === undefined ? "status" : "alert"}
    >
      <MousePointer2Icon
        aria-hidden="true"
        className={cn(
          "size-[15px] shrink-0",
          error === undefined ? "text-status-running" : "text-status-recording"
        )}
      />
      <span className="truncate">
        {error ?? `${verb} an element to attach it to the comment`}
      </span>
      <Kbd aria-label="Escape cancels" className="text-foreground">
        Esc
      </Kbd>
    </div>
  );
};
