import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

import {
  ElementButton,
  ElementChip,
  EvidenceChip,
  EvidenceIcon,
  PerformanceChoices,
  ScanChip,
  ScanIcon,
  SuggestionChip,
} from "./chips";
import { ComposerShell, ComposerTextarea } from "./composer-shell";
import {
  attach,
  detach,
  draftEvidence,
  evidenceId,
  evidenceTitle,
  expectedCookie,
  findStep,
  openTimespan,
  pickScan,
  requests,
  setDraft,
  setRequired,
  storageItems,
  updateCheck,
} from "./model";
import type { Evidence } from "./model";
import { EvidencePicker, StepSelect } from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

const observedChange = (item: Evidence) => {
  if (item.kind === "request") {
    return `${item.status} · ${item.status >= 400 ? "failed" : "returned"}`;
  }
  const verbs = {
    changed: "changed",
    created: "created",
    unchanged: "already there",
  } as const;
  return `${item.area === "cookie" ? "Cookie" : "Storage"} ${verbs[item.change]}`;
};

/**
 * Direction D — suggested from what happened. Under the comment, the
 * composer lists what the chosen step caused: its requests, the cookies and
 * storage it changed, and the two scans. One press makes any of them a
 * requirement. Nothing needs to be found; “More” reaches anything else.
 */
export const SuggestApproach = () => {
  const [state, update] = useApproach("suggest");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const picked = draftEvidence(draft);
  const pickedIds = new Set(picked.map((item) => item.id));
  const checkOf = (id: string) =>
    draft.checks.find((check) => evidenceId(check) === id);
  const step = findStep(draft.stepId);
  const caused: readonly Evidence[] = [...requests, ...storageItems].filter(
    (item) =>
      item.stepId === draft.stepId &&
      (item.kind === "request" || item.change !== "unchanged")
  );
  // Picked items stay where they were suggested; anything picked from
  // elsewhere follows them.
  const shown = [
    ...caused,
    ...picked.filter((item) => !caused.some((other) => other.id === item.id)),
  ];
  const openSpan = openTimespan(state.conditions);
  const surface = (name: string) => (open: boolean) =>
    update((current) => ({ ...current, surface: open ? name : undefined }));
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerShell
        description="Tell the agent about this moment. Below the comment, press anything the last step caused to require it on later Runs."
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <ElementButton
            element={draft.element}
            onPick={(element) =>
              update((current) => setDraft(current, { element }))
            }
          />
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          {draft.element === undefined ? null : (
            <ElementChip
              element={draft.element}
              onRemove={() =>
                update((current) => setDraft(current, { element: undefined }))
              }
            />
          )}
          <ComposerTextarea
            field={field}
            onChange={(note) =>
              update((current) => setDraft(current, { note }))
            }
            placeholder="What should the agent know about this moment?"
            value={draft.note}
          />
        </div>
        <section
          aria-label="What happened"
          className="bg-muted/30 mx-3 mb-3 flex flex-col gap-2 rounded-xl border p-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StepSelect
              onChange={(stepId) =>
                update((current) => setDraft(current, { stepId }))
              }
              value={draft.stepId}
            />
            <span className="text-muted-foreground text-xs">
              Press to require on later Runs
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((item) =>
              pickedIds.has(item.id) ? (
                <EvidenceChip
                  check={checkOf(item.id)}
                  evidence={item}
                  key={item.id}
                  onChange={(check) =>
                    update((current) => updateCheck(current, check))
                  }
                  onOpenChange={surface(`chip:${item.id}`)}
                  onRemove={() => update((current) => detach(current, item.id))}
                  onRequire={(required) =>
                    update((current) => setRequired(current, item, required))
                  }
                  open={state.surface === `chip:${item.id}`}
                  stepId={draft.stepId}
                />
              ) : (
                <SuggestionChip
                  description={observedChange(item)}
                  icon={<EvidenceIcon evidence={item} />}
                  key={item.id}
                  onPress={() =>
                    update((current) => setRequired(current, item, true))
                  }
                  title={evidenceTitle(item)}
                />
              )
            )}
            {draft.scan === undefined ? (
              <>
                <Popover
                  onOpenChange={surface("scan")}
                  open={state.surface === "scan"}
                >
                  <PopoverTrigger
                    render={
                      <Button
                        className="h-auto rounded-lg border-dashed py-1.5"
                        size="sm"
                        type="button"
                        variant="outline"
                      />
                    }
                  >
                    <ScanIcon mode="reload" />
                    Performance
                  </PopoverTrigger>
                  <PopoverContent align="start" positionerClassName="z-[60]">
                    <PopoverTitle>
                      Measure performance on later Runs
                    </PopoverTitle>
                    <PerformanceChoices
                      onSelect={(scan) =>
                        update((current) => ({
                          ...pickScan(current, scan),
                          surface: undefined,
                        }))
                      }
                      openSpan={openSpan}
                    />
                  </PopoverContent>
                </Popover>
                <Button
                  className="h-auto rounded-lg border-dashed py-1.5"
                  disabled={openSpan !== undefined}
                  onClick={() =>
                    update((current) =>
                      pickScan(current, {
                        mode: "accessibility",
                        phase: "start",
                      })
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <ScanIcon mode="accessibility" />
                  Accessibility
                </Button>
              </>
            ) : (
              <ScanChip
                onRemove={() =>
                  update((current) => setDraft(current, { scan: undefined }))
                }
                scan={draft.scan}
              />
            )}
            <Popover
              onOpenChange={surface("more")}
              open={state.surface === "more"}
            >
              <PopoverTrigger
                render={
                  <Button
                    className="h-auto rounded-lg py-1.5"
                    size="sm"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" />
                More
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[28rem] p-1.5"
                positionerClassName="z-[60]"
              >
                <EvidencePicker
                  kind="all"
                  onNewCookie={(name) =>
                    update((current) => ({
                      ...setRequired(
                        current,
                        expectedCookie(name, current.draft.stepId ?? ""),
                        true
                      ),
                      surface: undefined,
                    }))
                  }
                  onPick={(item) =>
                    update((current) => ({
                      ...attach(current, item),
                      surface: undefined,
                    }))
                  }
                  pickedIds={pickedIds}
                />
              </PopoverContent>
            </Popover>
          </div>
          {caused.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <PlusIcon aria-hidden="true" className="size-3" />
              {step === undefined
                ? "Checking the current state: use More to pick a cookie or stored item."
                : "That step caused no requests or storage changes. Use More for anything else."}
            </p>
          ) : null}
        </section>
      </ComposerShell>
    </PrototypeWorkspace>
  );
};
