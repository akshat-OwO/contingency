import type { NativeTeachingInstruction } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { MousePointer2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CommentCard, CommentChip } from "./comment-card";
import { roleWord } from "./screen-elements";
import type { AttachedElement, CommentPin } from "./screen-elements";
import { elapsedLabel } from "./teaching-recording-state";

/**
 * The native Teaching comment card, on Android and iOS: the same card as on
 * the Web, without the browser's scans and checks. Attach element turns the
 * device screen into a picker; the chosen element sits in the card as a chip
 * and is sent with the comment. Escape cancels a pick first, then closes the
 * card. The draft stays until the comment saves.
 */
export const NativeCommentComposer = ({
  attached,
  canAttach,
  instructions,
  onAttach,
  onCancelPick,
  onDetach,
  onDismiss,
  onHighlight,
  onSubmit,
  pending,
  picking,
  pins,
  startedAt,
}: {
  readonly attached: AttachedElement | undefined;
  /** Whether the screen shows an observation to pick from. */
  readonly canAttach: boolean;
  /** The recording's comments, oldest first. */
  readonly instructions: readonly NativeTeachingInstruction[];
  readonly onAttach: () => void;
  readonly onCancelPick: () => void;
  readonly onDetach: () => void;
  readonly onDismiss: () => void;
  readonly onHighlight: (index?: number) => void;
  readonly onSubmit: (text: string) => void;
  readonly pending: boolean;
  readonly picking: boolean;
  /** The comments pinned on the current screen. */
  readonly pins: readonly CommentPin[];
  readonly startedAt: string | undefined;
}) => {
  const [draftAtom] = useState(() => Atom.make(""));
  const [draft, setDraft] = useAtom(draftAtom);
  const field = useRef<HTMLTextAreaElement>(null);
  // A pick lands after the press on the screen took focus. Writing about the
  // element is next, so the field takes it back.
  useEffect(() => {
    if (attached !== undefined) {
      field.current?.focus();
    }
  }, [attached]);
  const pinned = new Set(pins.map((pin) => pin.index));
  const submit = () => {
    if (draft.trim() !== "") {
      onSubmit(draft.trim());
    }
  };
  return (
    <CommentCard
      attach={{
        attached: attached !== undefined,
        disabled: !canAttach,
        onCancel: onCancelPick,
        onPick: onAttach,
        picking,
      }}
      canSubmit={!pending && draft.trim() !== ""}
      chips={
        attached === undefined ? null : (
          <CommentChip
            disabled={pending}
            icon={<MousePointer2Icon aria-hidden="true" />}
            onRemove={() => {
              onDetach();
              field.current?.focus();
            }}
            removeLabel="Remove attached element"
            tone="element"
          >
            <span className="truncate">{attached.label}</span>
            <span className="shrink-0 opacity-70">
              {roleWord(attached.role)}
            </span>
          </CommentChip>
        )
      }
      draft={draft}
      earlier={instructions.map((instruction, position) => ({
        id: instruction.id,
        index: position + 1,
        pinned: pinned.has(position + 1),
        target: instruction.target ?? undefined,
        text: instruction.text,
        time:
          startedAt === undefined
            ? ""
            : elapsedLabel(startedAt, Date.parse(instruction.at)),
      }))}
      editingId={undefined}
      error={undefined}
      fieldRef={field}
      onBackspaceEmpty={attached === undefined ? undefined : onDetach}
      onDraftChange={setDraft}
      onHighlight={onHighlight}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
      onSubmit={submit}
      open
      pending={pending}
      placeholder={
        attached === undefined
          ? "What should the agent know about this screen?"
          : "What should change here?"
      }
      startedAt={startedAt}
    />
  );
};
