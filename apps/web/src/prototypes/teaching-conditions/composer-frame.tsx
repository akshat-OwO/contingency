import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CornerDownLeftIcon, MousePointerClickIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { ShortcutKbd } from "@/components/agent/teaching-comment-composer";
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
  canAdd,
  commitDraft,
  emptyDraft,
  removeCondition,
  startEdit,
} from "./model";
import type { PrototypeState } from "./model";
import { ConditionHistory } from "./parts";
import { useStage } from "./stage-context";

/**
 * The comment composer's frame, drawn as production draws it: a modal over
 * the browser stage, the draft on top, one toolbar, the recording's earlier
 * comments, and the shortcut footer. Each prototype fills in the draft.
 */
export const ComposerFrame = ({
  children,
  initialFocus,
  onEditStart,
  state,
  toolbar,
  update,
  wide = false,
}: {
  readonly children: ReactNode;
  readonly initialFocus: RefObject<HTMLElement | null>;
  readonly onEditStart?: () => void;
  readonly state: PrototypeState;
  readonly toolbar: ReactNode;
  readonly update: (
    change: (current: PrototypeState) => PrototypeState
  ) => void;
  readonly wide?: boolean;
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
  return (
    <Dialog
      // Production's composer is modal. Here it is not, so the gallery header
      // and the real devtools stay reachable by pointer, keyboard, and screen
      // reader while a draft is open.
      modal={false}
      onOpenChange={(open) =>
        update((current) => ({ ...current, composing: open }))
      }
      open={state.composing}
    >
      <DialogPortal container={stage}>
        <DialogOverlay className="absolute bg-black/15 supports-backdrop-filter:backdrop-blur-none dark:bg-black/40" />
        <DialogPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-2 data-closed:animate-out data-closed:fade-out-0 absolute top-[6%] left-1/2 z-50 flex max-h-[80%] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-sm shadow-2xl ring-1 outline-none",
            wide
              ? "w-[min(52rem,calc(100%-2rem))]"
              : "w-[min(36rem,calc(100%-2rem))]"
          )}
          initialFocus={initialFocus}
        >
          <DialogTitle className="sr-only">Comment</DialogTitle>
          <DialogDescription className="sr-only">
            Tell the agent about this moment. In the Attach approach,
            attachments provide context. Choose Add check to require a result on
            later Runs.
          </DialogDescription>
          <form
            className="flex min-h-0 flex-col overflow-y-auto"
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
            <div className="flex flex-wrap items-center gap-1 px-3 pb-3">
              <Button
                disabled
                size="sm"
                title="Element attach works as it does today"
                type="button"
                variant="ghost"
              >
                <MousePointerClickIcon aria-hidden="true" />
                Attach element
              </Button>
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
            <span className="inline-flex items-center gap-1.5">
              <ShortcutKbd platform="mac" scope="chord" shortcut="inspect" />
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
