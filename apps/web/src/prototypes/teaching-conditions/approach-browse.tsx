import { CheckIcon } from "lucide-react";
import { useRef } from "react";

import { SegmentedControl } from "@/components/browser/segmented-control";
import { cn } from "@/lib/utils";

import { ComposerFrame, ComposerTextarea } from "./composer-frame";
import {
  addCheck,
  canAdd,
  checkFor,
  evidenceId,
  findStep,
  lastStepId,
  removeCheck,
  replaceCheck,
  requests,
  setDraft,
  storageItems,
} from "./model";
import type { Evidence } from "./model";
import { CheckCard, EvidenceRow, SentencePreview, StepSelect } from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

type Tab = "request" | "storage";

const lists: Record<Tab, readonly Evidence[]> = {
  request: requests,
  storage: storageItems,
};

/**
 * Approach 3 — the evidence sits inside the composer. A wider composer lists
 * the requests and storage beside the comment, so picking is one click and
 * the comment never loses sight of what it is about.
 */
export const BrowseApproach = () => {
  const [state, update] = useApproach("browse");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const tab: Tab = state.surface === "storage" ? "storage" : "request";
  const picked = new Set(draft.checks.map(evidenceId));
  const toggle = (item: Evidence) =>
    update((current) => {
      const index = current.draft.checks.findIndex(
        (check) => evidenceId(check) === item.id
      );
      return index === -1
        ? addCheck(current, checkFor(item))
        : removeCheck(current, index);
    });
  const lastStep = findStep(lastStepId);
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerFrame
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={null}
        update={update}
        wide
      >
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 border-b">
          <section
            aria-label="What the page did"
            className="flex min-h-0 flex-col border-r"
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <SegmentedControl<Tab>
                label="Show"
                onChange={(value) =>
                  update((current) => ({ ...current, surface: value }))
                }
                options={[
                  {
                    count: requests.length,
                    label: "Requests",
                    value: "request",
                  },
                  {
                    count: storageItems.length,
                    label: "Storage",
                    value: "storage",
                  },
                ]}
                value={tab}
              />
            </div>
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
              {lists[tab].map((item, index) => {
                const firstEarlier =
                  item.stepId !== lastStepId &&
                  (index === 0 || lists[tab][index - 1]?.stepId === lastStepId);
                return (
                  <li key={item.id}>
                    {index === 0 && item.stepId === lastStepId ? (
                      <p className="text-muted-foreground px-2 pt-1 pb-1 text-xs font-medium">
                        Since your last step · {lastStep?.label}
                      </p>
                    ) : null}
                    {firstEarlier ? (
                      <p className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">
                        Earlier in the recording
                      </p>
                    ) : null}
                    <button
                      aria-pressed={picked.has(item.id)}
                      className={cn(
                        "hover:bg-muted/60 focus-visible:bg-muted flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left outline-none",
                        picked.has(item.id) && "bg-blue-500/10"
                      )}
                      onClick={() => toggle(item)}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded border",
                          picked.has(item.id) &&
                            "bg-primary text-primary-foreground border-primary"
                        )}
                      >
                        {picked.has(item.id) ? (
                          <CheckIcon className="size-3" />
                        ) : null}
                      </span>
                      <EvidenceRow evidence={item} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
            {draft.checks.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Tick a request or stored item to make it something later Runs
                must check. Or just write.
              </p>
            ) : null}
            {draft.checks.map((check, index) => (
              <CheckCard
                check={check}
                key={evidenceId(check)}
                onChange={(next) =>
                  update((current) => replaceCheck(current, index, next))
                }
                onRemove={() =>
                  update((current) => removeCheck(current, index))
                }
                stepId={draft.stepId}
              />
            ))}
            <ComposerTextarea
              className="min-h-10 text-sm leading-6"
              field={field}
              onChange={(note) =>
                update((current) => setDraft(current, { note }))
              }
              placeholder={
                draft.checks.length === 0
                  ? "What should the agent know about this moment?"
                  : "Anything else that should be true? (optional)"
              }
              value={draft.note}
            />
            {canAdd(draft) ? (
              <>
                <StepSelect
                  onChange={(stepId) =>
                    update((current) => setDraft(current, { stepId }))
                  }
                  value={draft.stepId}
                />
                <SentencePreview draft={draft} />
              </>
            ) : null}
          </div>
        </div>
        <span className="h-3" />
      </ComposerFrame>
    </PrototypeWorkspace>
  );
};
