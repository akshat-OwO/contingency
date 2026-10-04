import { AtSignIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";

import { ComposerFrame, ComposerTextarea } from "./composer-frame";
import {
  addCheck,
  canAdd,
  checkFor,
  evidenceId,
  evidenceTitle,
  removeCheck,
  replaceCheck,
  setDraft,
} from "./model";
import type { Evidence, PrototypeState } from "./model";
import {
  CheckCard,
  EvidencePicker,
  SentencePreview,
  StepSelect,
} from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

const MENTION = "mention:";

/** Where the `@` that opened the picker sits in the text, if it is open. */
const mentionAt = (state: PrototypeState) =>
  state.surface?.startsWith(MENTION) === true
    ? Number(state.surface.slice(MENTION.length))
    : undefined;

const insertMention = (
  state: PrototypeState,
  at: number,
  evidence: Evidence
): PrototypeState => {
  const { note } = state.draft;
  const token = `@${evidenceTitle(evidence)} `;
  const next = addCheck(state, checkFor(evidence));
  return {
    ...setDraft(next, {
      note: `${note.slice(0, at)}${token}${note.slice(at + 1)}`,
    }),
    surface: undefined,
  };
};

/**
 * Approach 2 — mention it while you write. Typing `@` in the comment lists
 * what the page did; the mention stays in your words and its check appears
 * under the text.
 */
export const MentionApproach = () => {
  const [state, update] = useApproach("mention");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const at = mentionAt(state);
  const openPicker = (position: number) =>
    update((current) => ({ ...current, surface: `${MENTION}${position}` }));
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerFrame
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <Button
            onClick={() => {
              const position = draft.note.length;
              update((current) =>
                setDraft(current, { note: `${current.draft.note}@` })
              );
              openPicker(position);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <AtSignIcon aria-hidden="true" />
            Mention a request or storage
          </Button>
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          <ComposerTextarea
            field={field}
            onChange={(note, caret) => {
              update((current) => setDraft(current, { note }));
              if (note.length > draft.note.length && note[caret - 1] === "@") {
                openPicker(caret - 1);
              }
            }}
            placeholder="Type @ to mention a request or storage, e.g. “After I submit, @POST /api/order should return status ready”"
            value={draft.note}
          />
          {at === undefined ? null : (
            <div
              className="rounded-xl p-1.5 ring-1 ring-blue-500/30"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  update((current) => ({ ...current, surface: undefined }));
                  field.current?.focus();
                }
              }}
            >
              <EvidencePicker
                kind="all"
                onPick={(evidence) => {
                  update((current) => insertMention(current, at, evidence));
                  field.current?.focus();
                }}
                pickedIds={new Set(draft.checks.map(evidenceId))}
              />
            </div>
          )}
          {draft.checks.map((check, index) => (
            <CheckCard
              check={check}
              key={evidenceId(check)}
              onChange={(next) =>
                update((current) => replaceCheck(current, index, next))
              }
              onRemove={() => update((current) => removeCheck(current, index))}
              stepId={draft.stepId}
            />
          ))}
          {canAdd(draft) ? (
            <>
              <StepSelect
                onChange={(stepId) =>
                  update((current) => setDraft(current, { stepId }))
                }
                value={draft.stepId}
              />
              {draft.checks.length > 0 ? (
                <SentencePreview draft={{ ...draft, note: "" }} />
              ) : null}
            </>
          ) : null}
        </div>
      </ComposerFrame>
    </PrototypeWorkspace>
  );
};
