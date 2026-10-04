import {
  AccessibilityIcon,
  CookieIcon,
  GaugeIcon,
  MousePointerClickIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { ElementChip, EvidenceChip, ScanChip } from "./chips";
import { ComposerShell, ComposerTextarea } from "./composer-shell";
import {
  attach,
  detach,
  draftEvidence,
  evidenceId,
  evidenceTitle,
  expectedCookie,
  findStep,
  lastStepId,
  mockElements,
  openTimespan,
  pickScan,
  requests,
  scanLabels,
  setDraft,
  setRequired,
  storageItems,
  updateCheck,
} from "./model";
import type { Evidence, PrototypeState } from "./model";
import { EvidenceRow } from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

const everything: readonly Evidence[] = [...requests, ...storageItems];

const close = (current: PrototypeState): PrototypeState => ({
  ...current,
  menuQuery: "",
  surface: undefined,
});

/**
 * Direction C — one attach menu. The toolbar is a single Attach button, and
 * typing `/` opens the same menu. Elements, requests, storage, and both scans
 * live in it, newest first. Everything lands as a chip; a chip is context
 * until its editor says “Must happen”.
 */
export const PlusApproach = () => {
  const [state, update] = useApproach("plus");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const evidence = draftEvidence(draft);
  const checkOf = (id: string) =>
    draft.checks.find((check) => evidenceId(check) === id);
  const menuOpen = state.surface === "menu";
  const choose = (change: (current: PrototypeState) => PrototypeState) => {
    update((current) => close(change(current)));
    field.current?.focus();
  };
  const query = state.menuQuery.trim();
  const openSpan = openTimespan(state.conditions);
  const lastStep = findStep(lastStepId);
  const row = (item: Evidence) => (
    <CommandItem
      data-checked={evidence.some((picked) => picked.id === item.id)}
      key={item.id}
      onSelect={() => choose((current) => attach(current, item))}
      value={`${item.id} ${evidenceTitle(item)}`}
    >
      <EvidenceRow evidence={item} />
    </CommandItem>
  );
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerShell
        description="Tell the agent about this moment. Use Attach, or type slash, to add an element, a request, storage, or a scan."
        footerHints={
          <span className="inline-flex items-center gap-1.5">
            <Kbd>/</Kbd>
            attach anything
          </span>
        }
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <Popover
            onOpenChange={(open) =>
              update((current) =>
                open ? { ...current, surface: "menu" } : close(current)
              )
            }
            open={menuOpen}
          >
            <PopoverTrigger
              render={<Button size="sm" type="button" variant="ghost" />}
            >
              <PlusIcon aria-hidden="true" />
              Attach
              <Kbd>/</Kbd>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[30rem] p-1.5"
              positionerClassName="z-[60]"
            >
              <Command className="rounded-lg! p-0">
                <CommandInput
                  autoFocus
                  onValueChange={(menuQuery) =>
                    update((current) => ({ ...current, menuQuery }))
                  }
                  placeholder="Search elements, requests, cookies, scans"
                  value={state.menuQuery}
                />
                <CommandList className="max-h-96">
                  <CommandEmpty>Nothing matches.</CommandEmpty>
                  <CommandGroup heading="On the page">
                    <CommandItem
                      onSelect={() =>
                        choose((current) =>
                          setDraft(current, {
                            element:
                              mockElements.find(
                                (item) => item.id !== current.draft.element?.id
                              ) ?? current.draft.element,
                          })
                        )
                      }
                      value="element pick inspect"
                    >
                      <MousePointerClickIcon aria-hidden="true" />
                      {draft.element === undefined
                        ? "Pick an element"
                        : "Pick a different element"}
                    </CommandItem>
                  </CommandGroup>
                  <CommandGroup
                    heading={`After ${lastStep?.label ?? "your last step"}`}
                  >
                    {everything.flatMap((item) =>
                      item.stepId === lastStepId ? [row(item)] : []
                    )}
                  </CommandGroup>
                  <CommandGroup heading="Measure on later Runs">
                    {openSpan === undefined ? (
                      (["reload", "navigation", "timespan"] as const).map(
                        (mode) => (
                          <CommandItem
                            key={mode}
                            onSelect={() =>
                              choose((current) =>
                                pickScan(current, { mode, phase: "start" })
                              )
                            }
                            value={`performance ${scanLabels[mode]}`}
                          >
                            <GaugeIcon aria-hidden="true" />
                            {scanLabels[mode]}
                            <span className="text-muted-foreground ml-auto text-xs">
                              Performance
                            </span>
                          </CommandItem>
                        )
                      )
                    ) : (
                      <CommandItem
                        onSelect={() =>
                          choose((current) =>
                            pickScan(current, {
                              mode: "timespan",
                              phase: "stop",
                            })
                          )
                        }
                        value="performance end timespan"
                      >
                        <SquareIcon aria-hidden="true" />
                        End timespan
                      </CommandItem>
                    )}
                    <CommandItem
                      disabled={openSpan !== undefined}
                      onSelect={() =>
                        choose((current) =>
                          pickScan(current, {
                            mode: "accessibility",
                            phase: "start",
                          })
                        )
                      }
                      value="accessibility scan a11y"
                    >
                      <AccessibilityIcon aria-hidden="true" />
                      Accessibility scan
                    </CommandItem>
                  </CommandGroup>
                  <CommandGroup heading="Earlier in the recording">
                    {everything.flatMap((item) =>
                      item.stepId === lastStepId ? [] : [row(item)]
                    )}
                  </CommandGroup>
                  {query === "" ? null : (
                    <CommandGroup heading="Not seen yet">
                      <CommandItem
                        onSelect={() =>
                          choose((current) =>
                            setRequired(
                              current,
                              expectedCookie(query, lastStepId),
                              true
                            )
                          )
                        }
                        value={`expect cookie ${query}`}
                      >
                        <CookieIcon aria-hidden="true" />
                        Expect a cookie named
                        <span className="font-mono">“{query}”</span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          {draft.element === undefined &&
          draft.scan === undefined &&
          evidence.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.element === undefined ? null : (
                <ElementChip
                  element={draft.element}
                  onRemove={() =>
                    update((current) =>
                      setDraft(current, { element: undefined })
                    )
                  }
                />
              )}
              {evidence.map((item) => (
                <EvidenceChip
                  check={checkOf(item.id)}
                  evidence={item}
                  key={item.id}
                  onChange={(check) =>
                    update((current) => updateCheck(current, check))
                  }
                  onOpenChange={(open) =>
                    update((current) => ({
                      ...current,
                      surface: open ? `chip:${item.id}` : undefined,
                    }))
                  }
                  onRemove={() => update((current) => detach(current, item.id))}
                  onRequire={(required) =>
                    update((current) => setRequired(current, item, required))
                  }
                  open={state.surface === `chip:${item.id}`}
                  stepId={draft.stepId}
                />
              ))}
              {draft.scan === undefined ? null : (
                <ScanChip
                  onRemove={() =>
                    update((current) => setDraft(current, { scan: undefined }))
                  }
                  scan={draft.scan}
                />
              )}
            </div>
          )}
          <ComposerTextarea
            field={field}
            onChange={(note) =>
              update((current) => setDraft(current, { note }))
            }
            onKeyDown={(event) => {
              const { selectionStart, value } = event.currentTarget;
              const before = value.slice(0, selectionStart);
              if (event.key === "/" && (before === "" || /\s$/u.test(before))) {
                event.preventDefault();
                update((current) => ({ ...current, surface: "menu" }));
              }
            }}
            placeholder="What should the agent know? Type / to attach anything."
            value={draft.note}
          />
        </div>
      </ComposerShell>
    </PrototypeWorkspace>
  );
};
