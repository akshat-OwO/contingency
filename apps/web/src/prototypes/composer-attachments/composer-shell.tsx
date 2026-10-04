import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CornerDownLeftIcon, PaperclipIcon } from "lucide-react";
import type { DragEvent, ReactNode, RefObject } from "react";

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

import {
  applyDrop,
  canAdd,
  commitDraft,
  decodeDrag,
  dragType,
  emptyDraft,
  removeCondition,
  startEdit,
} from "./model";
import type { PrototypeState } from "./model";
import { ConditionHistory, SentencePreview } from "./parts";
import { useStage } from "./stage-context";

type Update = (change: (current: PrototypeState) => PrototypeState) => void;

/**
 * The comment composer's frame, drawn as production draws it: a dialog over
 * the browser stage, the draft on top, one toolbar, the recording's earlier
 * comments, and the shortcut footer. Each prototype fills in the draft.
 *
 * It portals into the stage, so the devtools beside the stage stay usable
 * while a draft is open. With `acceptsDrops`, the whole frame is a drop
 * target for devtools rows and response fields.
 */
export const ComposerShell = ({
  acceptsDrops = false,
  children,
  description,
  footerHints,
  initialFocus,
  onEditStart,
  state,
  toolbar,
  update,
}: {
  readonly acceptsDrops?: boolean;
  readonly children: ReactNode;
  readonly description: string;
  readonly footerHints?: ReactNode;
  readonly initialFocus: RefObject<HTMLElement | null>;
  readonly onEditStart?: () => void;
  readonly state: PrototypeState;
  readonly toolbar: ReactNode;
  readonly update: Update;
}) => {
  const stage = useStage();
  const { draft } = state;
  const editing = draft.editingId !== undefined;
  const submit = () => {
    if (canAdd(draft)) {
      update(commitDraft);
      initialFocus.current?.focus();
    }
  };
  const dropping = acceptsDrops && state.dragging !== undefined;
  const dropHandlers = acceptsDrops
    ? {
        onDragOver: (event: DragEvent) => {
          if (event.dataTransfer.types.includes(dragType)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        },
        onDrop: (event: DragEvent) => {
          const payload = decodeDrag(event.dataTransfer.getData(dragType));
          if (payload === undefined) {
            return;
          }
          event.preventDefault();
          update((current) => ({
            ...applyDrop(current, payload),
            dragging: undefined,
          }));
          initialFocus.current?.focus();
        },
      }
    : {};
  const hasRequirement = draft.checks.length > 0 || draft.scan !== undefined;
  return (
    <Dialog
      // Production's composer is modal. These prototypes are not, so the
      // devtools stay reachable by pointer, keyboard, and screen reader while
      // a draft is open — the point of dragging from them. Pressing them
      // must not dismiss the draft either; Escape still closes it.
      disablePointerDismissal
      modal={false}
      onOpenChange={(open) =>
        update((current) => ({ ...current, composing: open }))
      }
      open={state.composing}
    >
      <DialogPortal container={stage}>
        <DialogOverlay className="absolute bg-black/10 supports-backdrop-filter:backdrop-blur-none dark:bg-black/30" />
        <DialogPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-2 data-closed:animate-out data-closed:fade-out-0 absolute top-[6%] left-1/2 z-50 flex max-h-[82%] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-sm shadow-2xl ring-1 transition-shadow outline-none",
            dropping && "ring-2 ring-blue-500/60"
          )}
          initialFocus={initialFocus}
          {...dropHandlers}
        >
          <DialogTitle className="sr-only">Comment</DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
          <form
            className="relative flex min-h-0 flex-col overflow-y-auto"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {editing ? (
              <p className="text-muted-foreground px-4 pt-3 text-xs">
                Editing comment
              </p>
            ) : null}
            {children}
            {hasRequirement ? (
              <div className="px-4 pb-2">
                <SentencePreview draft={draft} />
              </div>
            ) : null}
            <div className="bg-popover sticky bottom-0 z-10 flex flex-wrap items-center gap-1 px-3 pt-1 pb-3">
              {toolbar}
              <span className="flex-1" />
              {editing ? (
                <Button
                  onClick={() =>
                    update((current) => ({ ...current, draft: emptyDraft }))
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel edit
                </Button>
              ) : null}
              <Button disabled={!canAdd(draft)} size="sm" type="submit">
                {editing ? "Save comment" : "Add comment"}
                <Kbd className="bg-primary-foreground/15 text-primary-foreground">
                  <CornerDownLeftIcon aria-hidden="true" />
                </Kbd>
              </Button>
            </div>
            {dropping ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-2 grid place-items-center rounded-xl border-2 border-dashed border-blue-500/60 bg-blue-500/10 backdrop-blur-[1px]"
              >
                <span className="bg-popover inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-blue-700 shadow-sm dark:text-blue-300">
                  <PaperclipIcon className="size-4" />
                  {state.dragging === "field"
                    ? "Drop to require this value"
                    : "Drop to attach"}
                </span>
              </div>
            ) : null}
          </form>
          <section
            aria-label="Earlier in this recording"
            className="flex min-h-0 shrink-0 flex-col border-t"
          >
            <h2 className="text-muted-foreground px-4 pt-3 pb-1 text-xs font-medium">
              Earlier in this recording
            </h2>
            <div className="min-h-0 px-1.5 pb-1.5">
              <ConditionHistory
                conditions={state.conditions}
                editingId={draft.editingId}
                onEdit={(condition) => {
                  update((current) => startEdit(current, condition));
                  onEditStart?.();
                }}
                onRemove={(id) =>
                  update((current) => removeCondition(current, id))
                }
              />
            </div>
          </section>
          <footer className="text-muted-foreground bg-muted/40 flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeftIcon aria-hidden="true" />
              </Kbd>
              add
            </span>
            <span className="inline-flex items-center gap-1.5">
              <KbdGroup>
                <Kbd>⇧</Kbd>
                <Kbd>
                  <CornerDownLeftIcon aria-hidden="true" />
                </Kbd>
              </KbdGroup>
              new line
            </span>
            {footerHints}
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

/** The composer's text field: Enter adds, Shift+Enter breaks the line. */
export const ComposerTextarea = ({
  className,
  field,
  onChange,
  onKeyDown,
  placeholder,
  value,
}: {
  readonly className?: string;
  readonly field: RefObject<HTMLTextAreaElement | null>;
  readonly onChange: (value: string, caret: number) => void;
  readonly onKeyDown?: (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => void;
  readonly placeholder: string;
  readonly value: string;
}) => (
  <textarea
    aria-label="Comment"
    className={cn(
      "placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-14 w-full resize-none bg-transparent text-base leading-7 outline-none",
      className
    )}
    onChange={(event) =>
      onChange(event.target.value, event.target.selectionStart)
    }
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    }}
    placeholder={placeholder}
    ref={field}
    rows={1}
    value={value}
  />
);
