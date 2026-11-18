import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CrosshairIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { roleWord } from "./screen-elements";
import type { AttachedElement } from "./screen-elements";

/**
 * The native Teaching comment composer, on Android and iOS. Attach element
 * turns the device screen into a picker; the chosen element sits in the
 * composer as a chip and is sent with the comment. Escape cancels a pick
 * first, then closes the composer. The draft stays until the comment saves.
 */
export const NativeCommentComposer = ({
  attached,
  canAttach,
  onAttach,
  onCancelPick,
  onDetach,
  onDismiss,
  onSubmit,
  pending,
  picking,
}: {
  readonly attached: AttachedElement | undefined;
  /** Whether the screen shows an observation to pick from. */
  readonly canAttach: boolean;
  readonly onAttach: () => void;
  readonly onCancelPick: () => void;
  readonly onDetach: () => void;
  readonly onDismiss: () => void;
  readonly onSubmit: (text: string) => void;
  readonly pending: boolean;
  readonly picking: boolean;
}) => {
  const [draftAtom] = useState(() => Atom.make(""));
  const [draft, setDraft] = useAtom(draftAtom);
  return (
    <form
      aria-label="Comment"
      className="flex flex-col gap-1.5 border-b px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() === "") {
          return;
        }
        onSubmit(draft.trim());
      }}
    >
      {attached === undefined ? null : (
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="inline-flex min-w-0 items-center gap-1 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-600 dark:text-blue-400"
            data-slot="comment-element"
          >
            <CrosshairIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{attached.label}</span>
            <span className="text-muted-foreground shrink-0">
              {roleWord(attached.role)}
            </span>
          </span>
          <Button
            aria-label={`Detach ${attached.label}`}
            onClick={onDetach}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Instruction"
          autoFocus
          className="h-8 flex-1"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") {
              return;
            }
            // The stage's own Escape would close the picker's list too.
            event.preventDefault();
            if (picking) {
              onCancelPick();
            } else {
              onDismiss();
            }
          }}
          placeholder="Tell the agent what matters on this screen"
          value={draft}
        />
        <Button
          aria-pressed={picking}
          disabled={!canAttach}
          onClick={picking ? onCancelPick : onAttach}
          size="sm"
          type="button"
          variant={picking ? "secondary" : "ghost"}
        >
          <CrosshairIcon aria-hidden="true" />
          {attached === undefined ? "Attach element" : "Change element"}
        </Button>
        <Button
          disabled={pending || draft.trim() === ""}
          size="sm"
          type="submit"
        >
          Add
        </Button>
      </div>
      {picking ? (
        <p className="text-muted-foreground text-xs" role="status">
          Click an element on the screen, or choose one from Screen elements.
          Escape cancels.
        </p>
      ) : null}
    </form>
  );
};
